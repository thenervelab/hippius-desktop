"use client";

import {
  FC,
  useState,
  useRef,
  useEffect,
  memo,
} from "react";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { WaitAMoment } from "@/components/ui";
import FilesTable from "./files-table";
import CardView from "./card-view";
import IPFSNoEntriesFound from "./files-table/NoEntriesFound";
import InsufficientCreditsDialog from "./InsufficientCreditsDialog";
import UploadStatusWidget from "./UploadStatusWidget";
import SidebarDialog from "@/app/components/ui/SidebarDialog";
import { ActiveFilter } from "@/lib/utils/fileFilterUtils";
import DeleteConfirmationDialog from "@/app/components/DeleteConfirmationDialog";
import SidebarDialogContent from "./file-details-dialog-content";
import VideoDialog from "./files-table/VideoDialog";
import ImageDialog from "./files-table/ImageDialog";
import PdfDialog from "./files-table/PdfDialog";
import { toast } from "sonner";
import { useFileViewShared } from "./shared/FileViewUtils";
import FileContextMenu from "@/app/components/ui/context-menu";
import { downloadFile } from "@/app/lib/utils/downloadFile";
import { CloudUploadIcon, HardDrive } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDisplayName } from "@/lib/utils/fileTypeUtils";
import { useFileSelection } from "@/app/contexts/FileSelectionContext";
import NoMatchingResults from "./NoMatchingResults";

interface FilesContentProps {
  isRecentFiles?: boolean;
  isLoading: boolean;
  filteredData: Array<FormattedUserFile & { timestamp?: Date | null }>;
  displayedData: Array<FormattedUserFile & { timestamp?: Date | null }>;
  searchTerm: string;
  activeFilters: ActiveFilter[];
  viewMode: "list" | "card";
  shouldResetPagination: boolean;
  handlePaginationReset: () => void;
  error?: unknown;
  isPrivateView: boolean;
  addButtonRef?: React.RefObject<{ openWithFiles(files: FileList): void; openWithPaths(paths: string[]): void; isDialogOpen(): boolean } | null>;
  currentPage: number;
  totalPages: number;
  setCurrentPage: (page: number) => void;
  isSyncPathEmpty?: boolean;
  onSyncPathConfigured?: () => void;
  showFolderBadge?: boolean;
}

const FilesContent: FC<FilesContentProps> = ({
  isRecentFiles = false,
  isLoading,
  filteredData,
  displayedData,
  searchTerm,
  activeFilters,
  viewMode,
  shouldResetPagination,
  handlePaginationReset,
  error,
  isPrivateView,
  addButtonRef,
  currentPage,
  totalPages,
  setCurrentPage,
  isSyncPathEmpty = false,
  onSyncPathConfigured,
  showFolderBadge = false,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [animateCloud, setAnimateCloud] = useState(false);
  const dragTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Use selection context for delete functionality
  const { enterSelectionModeAndSelectFile } = useFileSelection();

  // Use shared functionality between FilesTable and CardView
  const sharedState = useFileViewShared({
    files: displayedData,
    isRecentFiles,
    resetPagination: shouldResetPagination,
    onPaginationReset: handlePaginationReset,
  });

  const {
    fileToDelete,
    setFileToDelete,
    openDeleteModal,
    setOpenDeleteModal,
    selectedFile,
    setSelectedFile,
    fileDetailsFile,
    setFileDetailsFile,
    isFileDetailsOpen,
    setIsFileDetailsOpen,
    deleteFile,
    isDeleting,
    getFileType,
    contextMenu,
    setContextMenu,
  } = sharedState;

  const selectedFileType = selectedFile ? getFileType(selectedFile) : null;

  // Tauri native drag-and-drop via global event listeners
  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");

        console.log("[DragDrop] Registering global Tauri drag-drop listeners");

        const unDragEnter = await listen<{ paths: string[]; position: { x: number; y: number } }>(
          "tauri://drag-enter",
          (event) => {
            console.log("[DragDrop] drag-enter event received", event.payload);
            if (isSyncPathEmpty && !isRecentFiles) return;
            // Don't show background overlay if upload dialog is already open
            if (addButtonRef?.current?.isDialogOpen()) return;
            setIsDragging(true);
            dragTimeoutRef.current = setTimeout(() => {
              setAnimateCloud(true);
            }, 200);
          }
        );
        unlisteners.push(unDragEnter);

        const unDragOver = await listen<{ position: { x: number; y: number } }>(
          "tauri://drag-over",
          () => {
            // Keep showing drag state
          }
        );
        unlisteners.push(unDragOver);

        const unDragDrop = await listen<{ paths: string[]; position: { x: number; y: number } }>(
          "tauri://drag-drop",
          async (event) => {
            console.log("[DragDrop] drag-drop event received", event.payload);
            setIsDragging(false);
            setAnimateCloud(false);
            if (dragTimeoutRef.current) {
              clearTimeout(dragTimeoutRef.current);
              dragTimeoutRef.current = null;
            }

            // If upload dialog is already open, don't handle here (FileDropzone handles it)
            if (addButtonRef?.current?.isDialogOpen()) return;

            if (isSyncPathEmpty && !isRecentFiles) {
              toast.info("Please set up sync folder first to upload files.");
              return;
            }

            const paths = event.payload.paths;
            if (!paths || paths.length === 0 || !addButtonRef?.current) return;

            // Filter out directories
            try {
              const { stat } = await import("@tauri-apps/plugin-fs");
              const results = await Promise.all(
                paths.map(async (p) => {
                  const info = await stat(p);
                  return { path: p, isDir: info.isDirectory };
                })
              );
              const dirs = results.filter((r) => r.isDir);
              const filePaths = results.filter((r) => !r.isDir).map((r) => r.path);

              if (dirs.length > 0) {
                toast.error(
                  "Folders cannot be uploaded via drag & drop. Please use the \"Add Folder\" button instead.",
                  { duration: 5000 }
                );
              }
              if (filePaths.length > 0) {
                addButtonRef.current.openWithPaths(filePaths);
              }
            } catch (err) {
              console.error("[DragDrop] Error checking paths:", err);
              // Fallback: pass all paths through
              addButtonRef.current.openWithPaths(paths);
            }
          }
        );
        unlisteners.push(unDragDrop);

        const unDragLeave = await listen(
          "tauri://drag-leave",
          () => {
            console.log("[DragDrop] drag-leave event received");
            setIsDragging(false);
            setAnimateCloud(false);
            if (dragTimeoutRef.current) {
              clearTimeout(dragTimeoutRef.current);
              dragTimeoutRef.current = null;
            }
          }
        );
        unlisteners.push(unDragLeave);

        console.log("[DragDrop] All listeners registered successfully");
      } catch (err) {
        console.error("[DragDrop] Failed to register drag-drop listeners:", err);
      }
    })();

    return () => {
      unlisteners.forEach((fn) => fn());
      if (dragTimeoutRef.current) {
        clearTimeout(dragTimeoutRef.current);
        dragTimeoutRef.current = null;
      }
    };
  }, [addButtonRef, isSyncPathEmpty, isRecentFiles]);

  const handleFileDownload = (
    file: FormattedUserFile,
    polkadotAddress: string
  ) => {
    downloadFile(file, polkadotAddress);
  };

  const renderContent = () => {

    // Only show full loading state on initial load (no data yet).
    // During background refetches (isFetching), keep showing existing data.
    if (isLoading) {
      return <WaitAMoment isRecentFiles={isRecentFiles} />;
    }

    if (
      (!filteredData.length && !searchTerm && activeFilters.length === 0) ||
      error
    ) {
      return (
        <IPFSNoEntriesFound
          isRecentFiles={isRecentFiles}
          isPrivateView={isPrivateView}
          isSyncPathConfigured={!isSyncPathEmpty}
          onStartSyncing={onSyncPathConfigured}
        />
      );
    }

    if (!filteredData.length && (searchTerm || activeFilters.length > 0)) {
      const hasActiveFilters = activeFilters.length > 0;
      const hasSearchTerm = Boolean(searchTerm && searchTerm.trim());

      return (
        <NoMatchingResults
          searchTerm={hasSearchTerm ? searchTerm : undefined}
          hasActiveFilters={hasActiveFilters}
        />
      );
    }

    if (viewMode === "list") {
      return (
        <FilesTable
          isRecentFiles={isRecentFiles}
          files={displayedData}
          allFiles={filteredData}
          resetPagination={shouldResetPagination}
          onPaginationReset={handlePaginationReset}
          handleFileDownload={handleFileDownload}
          sharedState={sharedState}
          currentPage={currentPage}
          totalPages={totalPages}
          setCurrentPage={setCurrentPage}
          showFolderBadge={showFolderBadge}
        />
      );
    } else {
      return (
        <CardView
          isRecentFiles={isRecentFiles}
          files={displayedData}
          resetPagination={shouldResetPagination}
          onPaginationReset={handlePaginationReset}
          handleFileDownload={handleFileDownload}
          sharedState={sharedState}
          currentPage={currentPage}
          totalPages={totalPages}
          setCurrentPage={setCurrentPage}
          showFolderBadge={showFolderBadge}
        />
      );
    }
  };
  return (
    <>
      <div
        className={cn(
          "w-full mt-4 relative",
          isDragging &&
          "after:absolute after:inset-0 after:bg-gray-50/50 after:border-2 after:border-primary-50 after:border-dashed after:rounded-lg after:z-10"
        )}
      >
        {isDragging && (
          <div className="absolute inset-0 bg-opacity-80 flex flex-col items-center justify-center z-20 pointer-events-none">
            <div
              className={cn(
                "relative transition-all duration-500 ease-in-out",
                animateCloud ? "scale-110 transform -translate-y-2" : ""
              )}
            >
              <div className="size-15 p-2 rounded-full flex items-center justify-center">
                <CloudUploadIcon className="size-10 text-[#3167dc] animate-slide-up" />
              </div>
            </div>

            <div className="mt-2 font-medium text-center bg-primary-50 p-4 rounded-lg shadow-lg">
              <div className="text-white text-base">
                Drop files here to upload them to
              </div>
              <div className="flex items-center justify-center">
                <HardDrive className="size-6 text-white mr-2" />
                <div className="text-white text-lg font-bold">IPFS Storage</div>
              </div>
            </div>
          </div>
        )}
        {renderContent()}
      </div>

      <DeleteConfirmationDialog
        open={openDeleteModal}
        onClose={() => {
          setOpenDeleteModal(false);
          setFileToDelete(null);
        }}
        onBack={() => {
          setOpenDeleteModal(false);
          setFileToDelete(null);
        }}
        onDelete={() => {
          setOpenDeleteModal(false);

          // Format the filename using the same logic as NameCell
          const truncatedName = fileToDelete?.name
            ? formatDisplayName(fileToDelete.name)
            : fileToDelete?.isFolder
              ? "folder"
              : "file";

          const toastId = toast.loading(`Deleting ${truncatedName}...`);

          setTimeout(() => {
            deleteFile()
              .then(() => {
                toast.success(
                  `${truncatedName} deleted successfully.`,
                  { id: toastId }
                );
                setFileToDelete(null);
              })
              .catch((error) => {
                console.error("Delete error:", error);
                toast.error(
                  error.message || `Failed to delete ${truncatedName}`,
                  { id: toastId }
                );
              });
          }, 2000);
        }}
        button={
          isDeleting
            ? "Deleting..."
            : `Delete ${fileToDelete?.isFolder ? "Folder" : "File"}`
        }
        text={`Are you sure you want to delete\n${fileToDelete?.name ? "\n" + fileToDelete.name : ""
          }`}
        heading={`Delete ${fileToDelete?.isFolder ? "Folder" : "File"}`}
        disableButton={isDeleting}
      />

      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          file={contextMenu.file}
          onClose={() => setContextMenu(null)}
          onDelete={(file) => {
            // Use new selection system instead of old modal system
            enterSelectionModeAndSelectFile(file);
            setContextMenu(null);
          }}
          onFileDownload={handleFileDownload}
          onSelectFile={(file) => {
            setSelectedFile(file);
            setContextMenu(null);
          }}
          onShowFileDetails={(file) => {
            setFileDetailsFile(file);
            setIsFileDetailsOpen(true);
            setContextMenu(null);
          }}
        />
      )}

      {selectedFileType === "video" && (
        <VideoDialog
          onCloseClicked={() => setSelectedFile(null)}
          handleFileDownload={handleFileDownload}
          file={selectedFile}
          allFiles={filteredData}
          onNavigate={setSelectedFile}
          isPrivateView={isPrivateView}
        />
      )}
      {selectedFileType === "image" && (
        <ImageDialog
          onCloseClicked={() => setSelectedFile(null)}
          handleFileDownload={handleFileDownload}
          file={selectedFile}
          allFiles={filteredData}
          onNavigate={setSelectedFile}
          isPrivateView={isPrivateView}
        />
      )}
      {selectedFileType === "PDF" && (
        <PdfDialog
          onCloseClicked={() => setSelectedFile(null)}
          handleFileDownload={handleFileDownload}
          file={selectedFile}
          allFiles={filteredData}
          onNavigate={setSelectedFile}
          isPrivateView={isPrivateView}
        />
      )}

      <InsufficientCreditsDialog />
      <UploadStatusWidget />

      <SidebarDialog
        heading={`${fileDetailsFile?.isFolder ? "Folder" : "File"} Details`}
        open={isFileDetailsOpen}
        onOpenChange={setIsFileDetailsOpen}
      >
        <SidebarDialogContent file={fileDetailsFile ?? undefined} />
      </SidebarDialog>


    </>
  );
};

export default memo(FilesContent);
