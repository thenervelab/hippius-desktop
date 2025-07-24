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
import SidebarDialog from "@/components/ui/sidebar-dialog";
import FilterDialogContent from "./filter-dialog-content";
import { ActiveFilter } from "@/lib/utils/fileFilterUtils";
import { FileTypes } from "@/lib/types/fileTypes";
import DeleteConfirmationDialog from "@/components/delete-confirmation-dialog";
import SidebarDialogContent from "./file-details-dialog-content";
import VideoDialog from "./files-table/VideoDialog";
import ImageDialog from "./files-table/ImageDialog";
import PdfDialog from "./files-table/PdfDialog";
import { toast } from "sonner";
import { useFileViewShared } from "./shared/file-view-utils";
import FileContextMenu from "@/app/components/ui/context-menu";
import { downloadIpfsFile } from "@/lib/utils/downloadIpfsFile";
import EncryptionKeyDialog from "./EncryptionKeyDialog";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { HardDrive } from "lucide-react";
import { CloudArrowUpIcon } from "@heroicons/react/24/outline";
import { cn } from "@/lib/utils";

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
    const { polkadotAddress } = useWalletAuth();

    const selectedFileType = selectedFile ? getFileType(selectedFile) : null;
    const [fileToDownload, setFileToDownload] =
        useState<FormattedUserIpfsFile | null>(null);
    const [isEncryptionDialogOpen, setIsEncryptionDialogOpen] = useState(false);
    const [encryptionKeyError, setEncryptionKeyError] = useState<string | null>(
        null
    );

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

        if (dragCounterRef.current === 0) {
            setIsDragging(false);
            setAnimateCloud(false);
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

    // Clean up any timers when component unmounts
    useEffect(() => {
        return () => {
            if (dragTimeoutRef.current) {
                clearTimeout(dragTimeoutRef.current);
            }
        };
    }, []);

    const handleFileDownload = (
        file: FormattedUserIpfsFile,
        polkadotAddress: string
    ) => {
        if (isPrivateView && file.source !== "Hippius") {
            setFileToDownload(file);
            setEncryptionKeyError(null);
            setIsEncryptionDialogOpen(true);
        } else {
            downloadIpfsFile(file, polkadotAddress, isPrivateView);
        }
    };

    const handleEncryptedDownload = async (encryptionKey: string | null) => {
        if (!fileToDownload || !polkadotAddress) return;

        const result = await downloadIpfsFile(
            fileToDownload,
            polkadotAddress,
            isPrivateView,
            encryptionKey
        );

        if (
            result &&
            !result.success &&
            (result.error === "INVALID_KEY" || result.error === "INVALID_KEY_FORMAT")
        ) {
            setEncryptionKeyError(
                result.message || "Incorrect encryption key. Please try again."
            );
            setIsEncryptionDialogOpen(true);
            return;
        }
        setIsEncryptionDialogOpen(false);
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
                                <CloudArrowUpIcon className="size-10 text-[#3167dc] animate-slide-up" />
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
                    toast.success("Deleting file...");

                    deleteFile()
                        .then(() => {
                            toast.success("Request submitted. File will be deleted!");
                            setFileToDelete(null);
                        })
                        .catch((error) => {
                            console.error("Delete error:", error);
                            toast.error(error.message || "Failed to delete file");
                        });
                }}
                button={isDeleting ? "Deleting..." : "Delete File"}
                text={`Are you sure you want to delete\n${fileToDelete?.name ? "\n" + fileToDelete.name : ""
                    }`}
                heading="Delete File"
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
            {selectedFileType === "pdfDocument" && (
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
                heading="File Details"
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

            <EncryptionKeyDialog
                open={isEncryptionDialogOpen}
                onClose={() => {
                    setIsEncryptionDialogOpen(false);
                    setEncryptionKeyError(null);
                }}
                onDownload={handleEncryptedDownload}
                keyError={encryptionKeyError}
            />
        </>
    );
};

export default memo(FilesContent);
