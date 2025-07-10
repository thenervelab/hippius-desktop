import React, { FC, useState, useEffect, useMemo, useCallback, useRef } from "react";
import useUserIpfsFiles, { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";
import { Button } from "@/components/ui/button";
import { MoreVertical, LinkIcon, Copy, Download, Trash2, HardDrive } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import usePagination from "@/lib/hooks/use-pagination";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import { CloudArrowUpIcon } from "@heroicons/react/24/outline";
import { WaitAMoment } from "@/components/ui";
import IPFSNoEntriesFound from "../files-table/ipfs-no-entries-found";
import FileCard from "./file-card";
import TableActionMenu from "@/components/ui/alt-table/table-action-menu";
import DeleteConfirmationDialog from "@/components/delete-confirmation-dialog";
import { useDeleteIpfsFile } from "@/lib/hooks";
import { downloadIpfsFile } from "@/lib/utils/downloadIpfsFile";
import VideoDialog from "../files-table/video-dialog";
import ImageDialog from "../files-table/image-dialog";
import PdfDialog from "../files-table/pdf-dialog";
import * as TableModule from "@/components/ui/alt-table";
import { useRouter } from 'next/navigation';
import FileDetailsDialog, { FileDetail } from "../files-table/unpin-files-dialog";
import FileContextMenu from "@/components/ui/context-menu/file-context-menu";

// Custom event names for file drop communication
const HIPPIUS_DROP_EVENT = "hippius:file-drop";
const TIME_BEFORE_ERR = 30 * 60 * 1000;

interface CardViewProps {
    showUnpinnedDialog?: boolean;
    files: FormattedUserIpfsFile[];
}

const CardView: FC<CardViewProps> = ({ showUnpinnedDialog = true, files }) => {
    const router = useRouter();

    const [fileToDelete, setFileToDelete] = useState<FormattedUserIpfsFile | null>(null);
    const [openDeleteModal, setOpenDeleteModal] = useState(false);
    const { mutateAsync: deleteFile, isPending: isDeleting } = useDeleteIpfsFile({
        cid: fileToDelete?.cid || "",
    });

    const [selectedFile, setSelectedFile] = useState<FormattedUserIpfsFile | null>(null);

    const [isDragging, setIsDragging] = useState(false);
    const [animateCloud, setAnimateCloud] = useState(false);

    const dragCounterRef = useRef<number>(0);
    const dragTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    const [unpinnedFiles, setUnpinnedFiles] = useState<FileDetail[] | null>(null);
    const [isUnpinnedOpen, setIsUnpinnedOpen] = useState(false);

    const [contextMenu, setContextMenu] = useState<{
        x: number;
        y: number;
        file: FormattedUserIpfsFile;
    } | null>(null);

    useEffect(() => {
        if (isDragging) {
            const timer = setTimeout(() => {
                setAnimateCloud(true);
            }, 200);
            return () => clearTimeout(timer);
        } else {
            setAnimateCloud(false);
        }
    }, [isDragging]);

    const handleFiles = useCallback((files: FileList) => {
        if (!files.length) {
            toast.error("No Files Found");
            return;
        }

        if (typeof window !== "undefined") {
            const event = new CustomEvent(HIPPIUS_DROP_EVENT, {
                detail: { files },
            });
            window.dispatchEvent(event);

            toast.success(
                `${files.length} ${files.length === 1 ? "file" : "files"} ready to upload`
            );
        }
    }, []);

    const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();

        if (
            e.dataTransfer.items &&
            Array.from(e.dataTransfer.items).some(item => item.kind === "file")
        ) {
            dragCounterRef.current += 1;
            setIsDragging(true);

            if (dragTimeoutRef.current) clearTimeout(dragTimeoutRef.current);
            dragTimeoutRef.current = setTimeout(() => {
                setAnimateCloud(true);
            }, 200);
        }
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();

        dragCounterRef.current -= 1;

        if (dragCounterRef.current === 0) {
            setIsDragging(false);
            setAnimateCloud(false);
        }
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        if (
            e.dataTransfer.items &&
            Array.from(e.dataTransfer.items).some(item => item.kind === "file")
        ) {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "copy";
        }
    }, []);

    const handleDrop = useCallback(
        (e: React.DragEvent<HTMLDivElement>) => {
            e.preventDefault();
            e.stopPropagation();

            // Reset counter and states
            dragCounterRef.current = 0;
            setIsDragging(false);
            setAnimateCloud(false);

            if (dragTimeoutRef.current) {
                clearTimeout(dragTimeoutRef.current);
            }

            const targetFiles = e.dataTransfer.files;
            if (targetFiles && targetFiles.length > 0) {
                handleFiles(targetFiles);
            }
        },
        [handleFiles]
    );

    useEffect(() => {
        return () => {
            if (dragTimeoutRef.current) {
                clearTimeout(dragTimeoutRef.current);
            }
        };
    }, []);

    const filteredData = useMemo(() => {
        // No need to filter deleted files as parent component already did this
        return files;
    }, [files]);

    const {
        paginatedData: data,
        setCurrentPage,
        currentPage,
        totalPages,
    } = usePagination(filteredData || [], 12); // Using more items per page for card view

    const handleDelete = () => {
        setOpenDeleteModal(true);
    };

    const selectedFileFormat = selectedFile
        ? getFilePartsFromFileName(selectedFile.name).fileFormat
        : null;

    const selectedFileType = selectedFileFormat
        ? getFileTypeFromExtension(selectedFileFormat)
        : null;

    const unpinnedFileDetails = useMemo(() => {
        if (!showUnpinnedDialog || !files) return [];

        const filteredUnpinnedFiles = files.filter((file) => !file.isAssigned);
        return filteredUnpinnedFiles.map((file) => ({
            filename: file.name || "Unnamed File",
            cid: decodeHexCid(file.cid),
            createdAt: file.createdAt,
        }));
    }, [files, showUnpinnedDialog]);

    useEffect(() => {
        if (!showUnpinnedDialog) return;

        if (unpinnedFileDetails.length > 0) {
            setUnpinnedFiles(unpinnedFileDetails);
            setIsUnpinnedOpen(true);
        } else {
            setUnpinnedFiles(null);
            setIsUnpinnedOpen(false);
        }
    }, [unpinnedFileDetails.length, showUnpinnedDialog]);

    const handleCardContextMenu = (e: React.MouseEvent, file: FormattedUserIpfsFile) => {
        e.preventDefault();
        setContextMenu({
            x: e.clientX,
            y: e.clientY,
            file: file
        });
    };

    return (
        <>
            <div className="flex flex-col gap-y-8 relative">
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
                    text={`Are you sure you want to delete\n${fileToDelete?.name ? "\n" + fileToDelete.name : ""}`}
                    heading="Delete File"
                    disableButton={isDeleting}
                />

                <div
                    className={cn(
                        "w-full relative min-h-[700px]",
                        isDragging &&
                        "after:absolute after:inset-0 after:bg-gray-50/50 after:border-2 after:border-primary-50 after:border-dashed after:rounded-lg after:z-10"
                    )}
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                    onDragEnter={handleDragEnter}
                    onDragLeave={handleDragLeave}
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
                                    <div className="text-white text-lg font-bold">
                                        IPFS Storage
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Card view container - Remove loading/error handling as it's now in parent */}
                    <div className="duration-300 delay-300">
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                            {data.map((file) => {
                                const { fileFormat } = getFilePartsFromFileName(file.name);
                                const fileType = getFileTypeFromExtension(fileFormat || null);

                                let cardState: "success" | "pending" | "error" = "success";
                                if (file.tempData) {
                                    cardState = "pending";
                                    if (Date.now() - file.tempData.uploadTime > TIME_BEFORE_ERR) {
                                        cardState = "error";
                                    }
                                }

                                const handleCardClick = () => {
                                    if (fileType === "video" || fileType === "image" || fileType === "pdfDocument") {
                                        setSelectedFile(file);
                                    } else if (fileType === "ec") {
                                        router.push(`/dashboard/storage/ipfs/${decodeHexCid(file.cid)}`);
                                    }
                                };

                                return (
                                    <div
                                        className="card-container"
                                        onContextMenu={(e) => handleCardContextMenu(e, file)}
                                    >
                                        <FileCard
                                            key={file.cid}
                                            file={file}
                                            state={cardState}
                                            onClick={handleCardClick}
                                            actionMenu={
                                                <TableActionMenu
                                                    dropdownTitle="IPFS Options"
                                                    dropDownMenuTriggerClass="size-5 text-grey-60 flex items-center"
                                                    items={[
                                                        {
                                                            icon: <LinkIcon className="size-4" />,
                                                            itemTitle: "View on IPFS",
                                                            onItemClick: () => {
                                                                if (fileType === "video") {
                                                                    setSelectedFile(file);
                                                                } else {
                                                                    window.open(
                                                                        `https://get.hippius.network/ipfs/${decodeHexCid(file.cid)}`,
                                                                        "_blank"
                                                                    );
                                                                }
                                                            },
                                                        },
                                                        {
                                                            icon: <Copy className="size-4" />,
                                                            itemTitle: "Copy Link",
                                                            onItemClick: () => {
                                                                navigator.clipboard
                                                                    .writeText(
                                                                        `https://get.hippius.network/ipfs/${decodeHexCid(file.cid)}`
                                                                    )
                                                                    .then(() => {
                                                                        toast.success("Copied to clipboard successfully!");
                                                                    });
                                                            },
                                                        },
                                                        {
                                                            icon: <Download className="size-4" />,
                                                            itemTitle: "Download",
                                                            onItemClick: async () => {
                                                                downloadIpfsFile(file);
                                                            },
                                                        },
                                                        ...(file.isAssigned
                                                            ? [
                                                                {
                                                                    icon: <Trash2 className="size-4" />,
                                                                    itemTitle: "Delete",
                                                                    onItemClick: () => {
                                                                        setFileToDelete(file);
                                                                        handleDelete();
                                                                    },
                                                                    variant: "destructive" as const,
                                                                },
                                                            ]
                                                            : []),
                                                    ]}
                                                >
                                                    <Button variant="ghost" size="icon" className="text-grey-70">
                                                        <MoreVertical className="size-4" />
                                                    </Button>
                                                </TableActionMenu>
                                            }
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                    <div className="my-8">
                        {totalPages > 1 && (
                            <TableModule.Pagination
                                currentPage={currentPage}
                                totalPages={totalPages}
                                setPage={setCurrentPage}
                            />
                        )}
                    </div>
                </div>

                {showUnpinnedDialog && unpinnedFiles && unpinnedFiles.length > 0 && (
                    <FileDetailsDialog
                        open={!isLoading && isUnpinnedOpen}
                        unpinnedFiles={unpinnedFiles}
                    />
                )}
            </div>

            {selectedFileType === "video" && (
                <VideoDialog
                    onCloseClicked={() => {
                        setSelectedFile(null);
                    }}
                    file={selectedFile}
                />
            )}
            {selectedFileType === "image" && (
                <ImageDialog
                    onCloseClicked={() => {
                        setSelectedFile(null);
                    }}
                    file={selectedFile}
                />
            )}
            {selectedFileType === "pdfDocument" && (
                <PdfDialog
                    onCloseClicked={() => {
                        setSelectedFile(null);
                    }}
                    file={selectedFile}
                />
            )}

            {contextMenu && (
                <FileContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    file={contextMenu.file}
                    onClose={() => setContextMenu(null)}
                    onDelete={(file) => {
                        setFileToDelete(file);
                        handleDelete();
                        setContextMenu(null);
                    }}
                    onSelectFile={(file) => {
                        setSelectedFile(file);
                        setContextMenu(null);
                    }}
                />
            )}
        </>
    );
};

export default CardView;
