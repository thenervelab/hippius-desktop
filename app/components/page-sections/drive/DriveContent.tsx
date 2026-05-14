"use client";

import {
  FC,
  useState,
  useRef,
  useEffect,
  useMemo,
  useCallback,
  memo,
} from "react";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import FilesTable from "./files-table";
import FilesTableSkeleton from "./files-table/FilesTableSkeleton";
import CardViewSkeleton from "./card-view/CardViewSkeleton";
import CardView from "./card-view";
import IPFSNoEntriesFound from "./files-table/FilesNoEntriesFound";
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
import { useSetAtom } from "jotai";
import { shareModalFileAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { downloadFile } from "@/app/lib/utils/downloadFile";
import { CloudUploadIcon, HardDrive } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDisplayName } from "@/lib/utils/fileTypeUtils";
import { useFileSelection } from "@/app/contexts/FileSelectionContext";
import NoMatchingResults from "./NoMatchingResults";
import BackgroundContextMenu from "@/app/components/ui/context-menu/BackgroundContextMenu";

interface DriveContentProps {
  isRecentFiles?: boolean;
  isLoading: boolean;
  filteredData: Array<FormattedUserFile & { timestamp?: Date | null }>;
  displayedData: Array<FormattedUserFile & { timestamp?: Date | null }>;
  searchTerm: string;
  activeFilters: ActiveFilter[];
  viewMode: "list" | "card";
  error?: unknown;
  addButtonRef?: React.RefObject<{
    openWithFiles(files: FileList): void;
    openWithPaths(paths: string[]): void;
    isDialogOpen(): boolean;
  } | null>;
  hasMore: boolean;
  loadMore: () => void;
  isSyncPathEmpty?: boolean;
  onSyncPathConfigured?: () => void;
  onUploadFile?: () => void;
  onAddFolder?: () => void;
  onAddSyncFolder?: () => void;
  drivePathsByLabel?: Record<string, string>;
  currentSubfolderPath?: string | null;
}

const DriveContent: FC<DriveContentProps> = ({
  isRecentFiles = false,
  isLoading,
  filteredData,
  displayedData,
  searchTerm,
  activeFilters,
  viewMode,
  error,
  addButtonRef,
  hasMore,
  loadMore,
  isSyncPathEmpty = false,
  onSyncPathConfigured,
  onUploadFile,
  onAddFolder,
  onAddSyncFolder,
  drivePathsByLabel,
  currentSubfolderPath,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [animateCloud, setAnimateCloud] = useState(false);
  const dragTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [bgContextMenu, setBgContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  // Opens `ShareFileModal` (mounted at the layout level) for the
  // selected file. Setting the atom is the only handoff — the modal
  // owns its own lifecycle from there.
  const setShareModalFile = useSetAtom(shareModalFileAtom);

  // Use selection context for delete functionality
  const { enterSelectionModeAndSelectFile } = useFileSelection();

  // Use shared functionality between FilesTable and CardView
  const sharedState = useFileViewShared();

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

  // Look up the latest version of the file details from live query data.
  // The captured snapshot in fileDetailsFile may have stale arion hashes
  // if it was opened before sync completed.
  const liveFileDetailsFile = useMemo(() => {
    if (!fileDetailsFile) return null;
    return (
      filteredData.find(
        (f) =>
          f.actualFileName === fileDetailsFile.actualFileName &&
          f.label === fileDetailsFile.label,
      ) ?? fileDetailsFile
    );
  }, [fileDetailsFile, filteredData]);

  // Tauri native drag-and-drop via global event listeners
  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");

        console.log("[DragDrop] Registering global Tauri drag-drop listeners");

        const unDragEnter = await listen<{
          paths: string[];
          position: { x: number; y: number };
        }>("tauri://drag-enter", (event) => {
          console.log("[DragDrop] drag-enter event received", event.payload);
          if (isSyncPathEmpty && !isRecentFiles) return;
          // Don't show background overlay if upload dialog is already open
          if (addButtonRef?.current?.isDialogOpen()) return;
          setIsDragging(true);
          dragTimeoutRef.current = setTimeout(() => {
            setAnimateCloud(true);
          }, 200);
        });
        unlisteners.push(unDragEnter);

        const unDragOver = await listen<{ position: { x: number; y: number } }>(
          "tauri://drag-over",
          () => {
            // Keep showing drag state
          },
        );
        unlisteners.push(unDragOver);

        const unDragDrop = await listen<{
          paths: string[];
          position: { x: number; y: number };
        }>("tauri://drag-drop", async (event) => {
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

          // Filter out directories (shows toast if any dropped)
          try {
            const { filterDroppedPaths } =
              await import("@/lib/utils/filterDroppedPaths");
            const filePaths = await filterDroppedPaths(paths);
            if (filePaths.length > 0) {
              addButtonRef.current.openWithPaths(filePaths);
            }
          } catch (err) {
            console.error("[DragDrop] Error checking paths:", err);
            // Fallback: pass all paths through
            addButtonRef.current.openWithPaths(paths);
          }
        });
        unlisteners.push(unDragDrop);

        const unDragLeave = await listen("tauri://drag-leave", () => {
          console.log("[DragDrop] drag-leave event received");
          setIsDragging(false);
          setAnimateCloud(false);
          if (dragTimeoutRef.current) {
            clearTimeout(dragTimeoutRef.current);
            dragTimeoutRef.current = null;
          }
        });
        unlisteners.push(unDragLeave);

        console.log("[DragDrop] All listeners registered successfully");
      } catch (err) {
        console.error(
          "[DragDrop] Failed to register drag-drop listeners:",
          err,
        );
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
    polkadotAddress: string,
  ) => {
    downloadFile(file, polkadotAddress);
  };

  const handleHeaderContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (isSyncPathEmpty || isRecentFiles || !onUploadFile) return;
      e.preventDefault();
      e.stopPropagation();
      window.getSelection()?.removeAllRanges();
      setBgContextMenu({ x: e.clientX, y: e.clientY });
    },
    [isSyncPathEmpty, isRecentFiles, onUploadFile],
  );

  const renderContent = () => {
    // Only show full loading state on initial load (no data yet).
    // During background refetches (isFetching), keep showing existing data.
    if (isLoading) {
      return viewMode === "card" ? (
        <CardViewSkeleton
          isRecentFiles={isRecentFiles}
          cards={isRecentFiles ? 4 : 8}
        />
      ) : (
        <FilesTableSkeleton
          isRecentFiles={isRecentFiles}
          rows={isRecentFiles ? 5 : 8}
        />
      );
    }

    if (
      (!filteredData.length && !searchTerm && activeFilters.length === 0) ||
      error
    ) {
      return (
        <IPFSNoEntriesFound
          isRecentFiles={isRecentFiles}
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
          handleFileDownload={handleFileDownload}
          sharedState={sharedState}
          hasMore={hasMore}
          loadMore={loadMore}
          onHeaderContextMenu={handleHeaderContextMenu}
          drivePathsByLabel={drivePathsByLabel}
          currentSubfolderPath={currentSubfolderPath}
          searchTerm={searchTerm}
          activeFilterCount={activeFilters.length}
        />
      );
    } else {
      return (
        <CardView
          isRecentFiles={isRecentFiles}
          files={displayedData}
          handleFileDownload={handleFileDownload}
          sharedState={sharedState}
          hasMore={hasMore}
          loadMore={loadMore}
        />
      );
    }
  };
  return (
    <>
      <div
        onContextMenu={(e) => {
          // Only show background context menu if sync path is configured and not on recent files
          if (isSyncPathEmpty || isRecentFiles || !onUploadFile) return;
          e.preventDefault();
          setBgContextMenu({ x: e.clientX, y: e.clientY });
        }}
        className={cn(
          "w-full relative select-none",
          viewMode === "card" && filteredData.length > 0 && "px-2.5",
          viewMode === "card" &&
            filteredData.length > 0 &&
            !isRecentFiles &&
            "mt-[11px]",
          isDragging &&
            "after:absolute after:inset-0 after:bg-gray-50/50 after:border-2 after:border-primary-50 after:border-dashed after:rounded-lg after:z-10",
        )}
      >
        {isDragging && (
          <div className="absolute inset-0 bg-opacity-80 flex flex-col items-center justify-center z-20 pointer-events-none">
            <div
              className={cn(
                "relative transition-all duration-500 ease-in-out",
                animateCloud ? "scale-110 transform -translate-y-2" : "",
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
                <div className="text-white text-lg font-bold">Drive</div>
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
                toast.success(`${truncatedName} deleted successfully.`, {
                  id: toastId,
                });
                setFileToDelete(null);
              })
              .catch((error) => {
                console.error("Delete error:", error);
                toast.error(
                  error.message || `Failed to delete ${truncatedName}`,
                  { id: toastId },
                );
              });
          }, 2000);
        }}
        button={
          isDeleting
            ? "Deleting..."
            : `Delete ${fileToDelete?.isFolder ? "Folder" : "File"}`
        }
        text={`Are you sure you want to delete\n${
          fileToDelete?.name ? "\n" + fileToDelete.name : ""
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
          onShareFile={(file) => {
            setShareModalFile(file);
            setContextMenu(null);
          }}
        />
      )}

      {bgContextMenu && onUploadFile && onAddFolder && (
        <BackgroundContextMenu
          x={bgContextMenu.x}
          y={bgContextMenu.y}
          onClose={() => setBgContextMenu(null)}
          onUploadFile={onUploadFile}
          onAddFolder={onAddFolder}
          onAddSyncFolder={onAddSyncFolder}
        />
      )}

      {selectedFileType === "video" && (
        <VideoDialog
          onCloseClicked={() => setSelectedFile(null)}
          handleFileDownload={handleFileDownload}
          file={selectedFile}
          allFiles={filteredData}
          onNavigate={setSelectedFile}
        />
      )}
      {selectedFileType === "image" && (
        <ImageDialog
          onCloseClicked={() => setSelectedFile(null)}
          handleFileDownload={handleFileDownload}
          file={selectedFile}
          allFiles={filteredData}
          onNavigate={setSelectedFile}
        />
      )}
      {selectedFileType === "PDF" && (
        <PdfDialog
          onCloseClicked={() => setSelectedFile(null)}
          handleFileDownload={handleFileDownload}
          file={selectedFile}
          allFiles={filteredData}
          onNavigate={setSelectedFile}
        />
      )}

      <UploadStatusWidget />

      <SidebarDialog
        heading={`${fileDetailsFile?.isFolder ? "Folder" : "File"} Details`}
        open={isFileDetailsOpen}
        onOpenChange={setIsFileDetailsOpen}
      >
        <SidebarDialogContent file={liveFileDetailsFile ?? undefined} />
      </SidebarDialog>
    </>
  );
};

export default memo(DriveContent);
