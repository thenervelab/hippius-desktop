"use client";

import {
    FC,
    useState,
    useRef,
    useCallback,
    useEffect,
    memo,
    DragEvent
} from "react";
import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";
import { Icons, WaitAMoment } from "@/components/ui";
import FilesTable from "./files-table";
import CardView from "./card-view";
import IPFSNoEntriesFound from "./files-table/IpfsNoEntriesFound";
import FileDetailsDialog, { FileDetail } from "./files-table/UnpinFilesDialog";
import InsufficientCreditsDialog from "./InsufficientCreditsDialog";
import UploadStatusWidget from "./UploadStatusWidget";
import SidebarDialog from "@/app/components/ui/SidebarDialog";
import FilterDialogContent from "./filter-dialog-content";
import { ActiveFilter } from "@/lib/utils/fileFilterUtils";
import { FileTypes } from "@/lib/types/fileTypes";
import DeleteConfirmationDialog from "@/app/components/DeleteConfirmationDialog";
import SidebarDialogContent from "./file-details-dialog-content";
import VideoDialog from "./files-table/VideoDialog";
import ImageDialog from "./files-table/ImageDialog";
import PdfDialog from "./files-table/PdfDialog";
import { toast } from "sonner";
import { useFileViewShared } from "./shared/FileViewUtils";
import FileContextMenu from "@/app/components/ui/context-menu";
import { downloadIpfsFile } from "@/lib/utils/downloadIpfsFile";
import { CloudUploadIcon, HardDrive } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDisplayName } from "@/lib/utils/fileTypeUtils";

interface FilesContentProps {
    isRecentFiles?: boolean;
    isLoading: boolean;
    isFetching: boolean;
    isProcessingTimestamps: boolean;
    filteredData: Array<FormattedUserIpfsFile & { timestamp?: Date | null }>;
    displayedData: Array<FormattedUserIpfsFile & { timestamp?: Date | null }>;
    searchTerm: string;
    activeFilters: ActiveFilter[];
    viewMode: "list" | "card";
    shouldResetPagination: boolean;
    handlePaginationReset: () => void;
    unpinnedFiles: FileDetail[] | null;
    isUnpinnedOpen: boolean;
    isFilterOpen: boolean;
    setIsFilterOpen: (isOpen: boolean) => void;
    selectedFileTypes: FileTypes[];
    selectedDate: string;
    selectedFileSize: number;
    selectedSizeUnit: string;
    handleApplyFilters: (
        fileTypes: FileTypes[],
        date: string,
        fileSize: number,
        sizeUnit: string
    ) => void;
    handleResetFilters: () => void;
    error?: unknown;
    isPrivateView: boolean;
    addButtonRef?: React.RefObject<{ openWithFiles(files: FileList): void }>;
}

const FilesContent: FC<FilesContentProps> = ({
    isRecentFiles = false,
    isLoading,
    isFetching,
    isProcessingTimestamps,
    filteredData,
    displayedData,
    searchTerm,
    activeFilters,
    viewMode,
    shouldResetPagination,
    handlePaginationReset,
    unpinnedFiles,
    isUnpinnedOpen,
    isFilterOpen,
    setIsFilterOpen,
    selectedFileTypes,
    selectedDate,
    selectedFileSize,
    selectedSizeUnit,
    handleApplyFilters,
    handleResetFilters,
    error,
    isPrivateView,
    addButtonRef
}) => {
    const [isDragging, setIsDragging] = useState(false);
    const [animateCloud, setAnimateCloud] = useState(false);
    const dragCounterRef = useRef(0);
    const dragTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    // Use shared functionality between FilesTable and CardView
    const sharedState = useFileViewShared({
        files: displayedData,
        showUnpinnedDialog: false,
        isRecentFiles,
        resetPagination: shouldResetPagination,
        onPaginationReset: handlePaginationReset
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
        setContextMenu
    } = sharedState;

    const selectedFileType = selectedFile ? getFileType(selectedFile) : null;

    // Drag and drop handlers
    const handleDragEnter = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();

        if (
            e.dataTransfer.items &&
            Array.from(e.dataTransfer.items).some((item) => item.kind === "file")
        ) {
            dragCounterRef.current++;
            setIsDragging(true);

            if (dragTimeoutRef.current) {
                clearTimeout(dragTimeoutRef.current);
            }

            dragTimeoutRef.current = setTimeout(() => {
                setAnimateCloud(true);
            }, 200);
        }
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();

        dragCounterRef.current--;

        if (dragCounterRef.current <= 0) {
            dragCounterRef.current = 0;
            setIsDragging(false);
            setAnimateCloud(false);
            if (dragTimeoutRef.current) {
                clearTimeout(dragTimeoutRef.current);
                dragTimeoutRef.current = null;
            }
        }
    }, []);

    const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(true);
    };

    const handleDrop = useCallback(
        (e: React.DragEvent) => {
            e.preventDefault();
            e.stopPropagation();

            dragCounterRef.current = 0;
            setIsDragging(false);
            setAnimateCloud(false);

            if (dragTimeoutRef.current) {
                clearTimeout(dragTimeoutRef.current);
                dragTimeoutRef.current = null;
            }

            if (addButtonRef?.current && e.dataTransfer.files.length > 0) {
                addButtonRef.current.openWithFiles(e.dataTransfer.files);
            } else if (e.dataTransfer.files.length > 0) {
                const customEvent = new CustomEvent("hippius:file-drop", {
                    detail: { files: e.dataTransfer.files }
                });
                window.dispatchEvent(customEvent);
            }
        },
        [addButtonRef]
    );

    // Add global event listeners to clean up dragging state when dragging ends outside
    useEffect(() => {
        const handleDragEnd = () => {
            // Only reset if we're currently showing dragging state
            if (isDragging) {
                dragCounterRef.current = 0;
                setIsDragging(false);
                setAnimateCloud(false);
                if (dragTimeoutRef.current) {
                    clearTimeout(dragTimeoutRef.current);
                    dragTimeoutRef.current = null;
                }
            }
        };

        // Only handle document-level dragleave that indicates leaving the window
        const handleDocumentDragLeave = (e: globalThis.DragEvent) => {
            // Check if mouse left the document area
            if (e.clientX <= 0 || e.clientY <= 0 ||
                e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
                handleDragEnd();
            }
        };

        document.addEventListener('dragend', handleDragEnd);
        document.addEventListener('dragleave', handleDocumentDragLeave);

        return () => {
            document.removeEventListener('dragend', handleDragEnd);
            document.removeEventListener('dragleave', handleDocumentDragLeave);
        };
    }, [isDragging]);  // Only re-add listeners if isDragging changes

    // Clean up any timers when component unmounts
    useEffect(() => {
        return () => {
            if (dragTimeoutRef.current) {
                clearTimeout(dragTimeoutRef.current);
                dragTimeoutRef.current = null;
            }
        };
    }, []);

    const handleFileDownload = (
        file: FormattedUserIpfsFile,
        polkadotAddress: string
    ) => {
        downloadIpfsFile(file, polkadotAddress, isPrivateView);
    };

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
                    searchTerm={searchTerm}
                    handleFileDownload={handleFileDownload}
                    activeFilters={activeFilters}
                    sharedState={sharedState}
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
                    handleFileDownload={handleFileDownload}
                    searchTerm={searchTerm}
                    activeFilters={activeFilters}
                    sharedState={sharedState}
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
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDragEnter={handleDragEnter}
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
                                Drop files here to upload them tosdfa
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
                        : fileToDelete?.isFolder ? "folder" : "file";

                    const toastId = toast.loading(`Deleting ${truncatedName}...`);

                    setTimeout(() => {
                        deleteFile()
                            .then(() => {
                                toast.success(
                                    `${truncatedName} removed.`,
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
                button={isDeleting ? "Deleting..." : `Delete ${fileToDelete?.isFolder ? "Folder" : "File"}`}
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
                        setFileToDelete(file);
                        setOpenDeleteModal(true);
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
                    allFiles={displayedData}
                    onNavigate={setSelectedFile}
                />
            )}
            {selectedFileType === "image" && (
                <ImageDialog
                    onCloseClicked={() => setSelectedFile(null)}
                    handleFileDownload={handleFileDownload}
                    file={selectedFile}
                    allFiles={displayedData}
                    onNavigate={setSelectedFile}
                />
            )}
            {selectedFileType === "PDF" && (
                <PdfDialog
                    onCloseClicked={() => setSelectedFile(null)}
                    handleFileDownload={handleFileDownload}
                    file={selectedFile}
                    allFiles={displayedData}
                    onNavigate={setSelectedFile}
                />
            )}

            {unpinnedFiles && unpinnedFiles.length > 0 && (
                <FileDetailsDialog
                    open={!isLoading && isUnpinnedOpen}
                    unpinnedFiles={unpinnedFiles}
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
        </>
    );
};

export default memo(FilesContent);
