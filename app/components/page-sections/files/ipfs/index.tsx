"use client";

import { FC, useEffect, useRef, useMemo, useState } from "react";
import useUserIpfsFiles from "@/lib/hooks/use-user-ipfs-files";
import { RefreshButton, Icons, P, SearchInput, Button } from "@/components/ui";
import AddButton from "./add-file-button";
import FilesTable from "./files-table";
import UploadStatusWidget from "./upload-status-widget";
import CardView from "./card-view";
import { cn } from "@/lib/utils";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import FileDetailsDialog, { FileDetail } from "./files-table/unpin-files-dialog";
import InsufficientCreditsDialog from "./insufficient-credits-dialog";

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
  const [filterMode, setFilterMode] = useState<"all" | "date" | "type">("all");


  // Unpinned files state - moved from FilesTable to parent
  const [unpinnedFiles, setUnpinnedFiles] = useState<FileDetail[] | null>(null);
  const [isUnpinnedOpen, setIsUnpinnedOpen] = useState(false);

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
  }, [unpinnedFileDetails.length]);

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

  return (
    <div className="w-full relative mt-6">
      <div className="flex items-center w-full justify-between gap-6 flex-wrap">
        <div className="flex items-center">
          <P
            size="xl"
            className="animate-fade-in-from-b-0.3 opacity-0"
          >Your Files</P>
        </div>
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
              className={cn("p-1 rounded", viewMode === "list" ? "bg-primary-100 border border-primary-80 text-primary-40 rounded" : "bg-grey-100 text-grey-70")}
              onClick={() => setViewMode("list")}
              aria-label="List View"
            >
              <Icons.Grid className="size-5" />
            </button>
            <button
              className={cn("p-1 rounded", viewMode === "card" ? "bg-primary-100 border border-primary-80 text-primary-40 rounded" : "bg-grey-100 text-grey-70")}
              onClick={() => setViewMode("card")}
              aria-label="Card View"
            >
              <Icons.Category className="size-5" />
            </button>
          </div>

          <div className="flex border border-grey-80 p-1 rounded">
            <button
              className={cn("p-1 rounded", filterMode === "date" ? "bg-primary-100 border border-primary-80 text-primary-40 rounded" : "bg-grey-100 text-grey-70")}
              onClick={() => setFilterMode("date")}
              aria-label="Date Filter"
            >
              <Icons.Filter className="size-5" />
            </button>
          </div>
          <div className="bg-grey-90 hover:bg-grey-80 rounded">
            <button
              className="px-4 py-3 bg-grey-90 hover:bg-grey-80 rounded text-sm font-medium text-grey-10 flex items-center gap-1 h-10"
              aria-label="Add Folder"
            >
              <Icons.FolderAdd className="size-4 text-grey-10" />
              <span>New Folder</span>
            </button>
          </div>

          <AddButton ref={addButtonRef} className="h-9" />
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
          There was an error loading your files. Please refresh the page or try
          again later.
        </div>
      )}

      <div className="w-full mt-4">
        {viewMode === "list" ? (
          <FilesTable
            showUnpinnedDialog={false}
          />
        ) : (
          <CardView
            showUnpinnedDialog={false}
          />
        )}
      </div>

      {unpinnedFiles && unpinnedFiles.length > 0 && (
        <FileDetailsDialog
          open={!isLoading && isUnpinnedOpen}
          unpinnedFiles={unpinnedFiles}
        />
      )}

      <UploadStatusWidget />
      <InsufficientCreditsDialog />
    </div>
  );
};

export default Ipfs;
