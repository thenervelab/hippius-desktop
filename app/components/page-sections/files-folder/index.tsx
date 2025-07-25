"use client";

import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { Icons, RefreshButton } from "@/components/ui";
import { cn } from "@/lib/utils";
import {
    FormattedUserIpfsFile,
    parseMinerIds
} from "@/lib/hooks/use-user-ipfs-files";
import FilesContent from "@/components/page-sections/files/ipfs/FilesContent";
import { toast } from "sonner";
import Link from "next/link";
import { ActiveFilter } from "@/lib/utils/fileFilterUtils";
import { FileTypes } from "@/lib/types/fileTypes";
import {
    filterFiles,
    generateActiveFilters
} from "@/lib/utils/fileFilterUtils";
import { SearchInput } from "@/components/ui";
import FilterChips from "@/components/page-sections/files/ipfs/filter-chips";
import { useAtom } from "jotai";
import { activeSubMenuItemAtom } from "@/app/components/sidebar/sideBarAtoms";
import EncryptionKeyDialog from "@/components/page-sections/files/ipfs/EncryptionKeyDialog";
import { downloadIpfsFolder } from "@/lib/utils/downloadIpfsFolder";
import AddFileToFolderButton from "@/components/page-sections/files/ipfs/AddFileToFolderButton";
import useDeleteIpfsFile from "@/lib/hooks/use-delete-ipfs-file";
import DeleteConfirmationDialog from "@/components/delete-confirmation-dialog";

interface FileEntry {
    file_name: string;
    file_size: number;
    cid: string;
    created_at: string;
    file_hash: string;
    last_charged_at: string;
    miner_ids: string | string[];
    source: string;
}

interface FolderViewProps {
    folderCid: string;
    folderName?: string;
}

export default function FolderView({
    folderCid,
    folderName = "Folder"
}: FolderViewProps) {
    const { polkadotAddress } = useWalletAuth();
    const [activeSubMenuItem] = useAtom(activeSubMenuItemAtom);
    const [files, setFiles] = useState<FormattedUserIpfsFile[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [viewMode, setViewMode] = useState<"list" | "card">("list");
    const [isDownloading, setIsDownloading] = useState(false);
    const [isEncryptionDialogOpen, setIsEncryptionDialogOpen] = useState(false);
    const [encryptionKeyError, setEncryptionKeyError] = useState<string | null>(
        null
    );
    const [selectedOutputDir, setSelectedOutputDir] = useState<string | null>(
        null
    );
    const [fileToDelete, setFileToDelete] = useState<FormattedUserIpfsFile | null>(null);
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

    const isPrivateFolder = activeSubMenuItem === "Private";
    const addButtonRef = useRef<{ openWithFiles(files: FileList): void }>(null);

    const [searchTerm, setSearchTerm] = useState("");
    const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
    const [shouldResetPagination, setShouldResetPagination] = useState(false);
    const [selectedFileTypes, setSelectedFileTypes] = useState<FileTypes[]>([]);
    const [selectedDate, setSelectedDate] = useState("");
    const [selectedFileSize, setSelectedFileSize] = useState(0);
    const [selectedSizeUnit, setSelectedSizeUnit] = useState("GB");
    const [isFilterOpen, setIsFilterOpen] = useState(false);

    const filteredData = useMemo(() => {
        return filterFiles(files, {
            searchTerm,
            fileTypes: selectedFileTypes,
            dateFilter: selectedDate,
            fileSize: selectedFileSize
        });
    }, [files, searchTerm, selectedFileTypes, selectedDate, selectedFileSize]);

    // File deletion mutation
    const { mutate: deleteFile, isPending: isDeleting } = useDeleteIpfsFile({
        cid: fileToDelete?.cid || "",
        fileToDelete,
        folderCid,
        folderName,
        isPrivateFolder
    });


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
    }, [searchTerm, selectedFileTypes, selectedDate, selectedFileSize]);

    const loadFolderContents = useCallback(async (showLoading = true) => {
        if (!folderCid) return;

        try {
            if (showLoading) {
                setIsLoading(true);
            } else {
                setIsRefreshing(true);
            }

            const fileEntries = await invoke<FileEntry[]>("list_folder_contents", {
                folderName: folderName,
                folderMetadataCid: folderCid
            });

            const formattedFiles = fileEntries.map(
                (entry): FormattedUserIpfsFile => {
                    const isErasureCoded = entry.file_name.endsWith(".ec_metadata");
                    const displayName = isErasureCoded
                        ? entry.file_name.slice(0, -".ec_metadata".length)
                        : entry.file_name;
                    return {
                        cid: entry.cid,
                        name: displayName || "Unnamed File",
                        size: entry.file_size,
                        type: entry.file_name.split(".").pop() || "unknown",
                        fileHash: entry.file_hash,
                        isAssigned: true,
                        source: entry.source,
                        createdAt: Number(entry.created_at),
                        minerIds: parseMinerIds(entry.miner_ids),
                        lastChargedAt: Number(entry.last_charged_at),
                        isErasureCoded,
                        parentFolderId: folderCid,
                        parentFolderName: folderName
                    };
                }
            );

            setFiles(formattedFiles);
            if (!showLoading) {
                toast.success("Folder contents refreshed successfully");
            }
        } catch (error) {
            console.error("Error loading folder contents:", error);
            toast.error(
                `Failed to load folder contents: ${error instanceof Error ? error.message : String(error)}`
            );
        } finally {
            if (showLoading) {
                setIsLoading(false);
            } else {
                setIsRefreshing(false);
            }
        }
    }, [folderCid, folderName]);

    useEffect(() => {
        loadFolderContents();
    }, [loadFolderContents]);

    const handleRefresh = () => {
        loadFolderContents(false);
    };

    const handleFileDownload = useCallback((
        file: FormattedUserIpfsFile,
        polkadotAddress: string
    ) => {
        if (isPrivateFolder && file.source !== "Hippius") {
            // Private file download handling
            // This would need to be implemented based on your system requirements
            toast.error("Private file download not implemented");
        } else {
            // Public file download
            // You could implement this based on existing file download functionality
            toast.error("File download from folder not implemented");
        }
    }, [isPrivateFolder]);

    // Handle file deletion
    const handleFileDelete = useCallback(() => {
        if (!fileToDelete) return;

        deleteFile(undefined, {
            onSuccess: () => {
                toast.success(`File ${fileToDelete.name} deleted from folder successfully!`);
                setFileToDelete(null);
                setIsDeleteDialogOpen(false);
                loadFolderContents(false);
            },
            onError: (error) => {
                toast.error(`Failed to delete file: ${error.message || "Unknown error"}`);
                console.error("Delete error:", error);
            }
        });
    }, [deleteFile, fileToDelete, loadFolderContents]);

    // Set up sharedState for FilesContent
    const sharedState = useMemo(() => ({
        files,
        setFileToDelete: (file: FormattedUserIpfsFile | null) => {
            setFileToDelete(file);
            setIsDeleteDialogOpen(true);
        },
        openDeleteModal: isDeleteDialogOpen,
        setOpenDeleteModal: setIsDeleteDialogOpen,
        selectedFile: null,
        setSelectedFile: () => { }, // No preview handling needed here
        fileDetailsFile: null,
        setFileDetailsFile: () => { }, // No details handling needed here
        isFileDetailsOpen: false,
        setIsFileDetailsOpen: () => { }, // No details handling needed here
        deleteFile: handleFileDelete,
        isDeleting,
        getFileType: () => null,
        contextMenu: null,
        setContextMenu: () => { },
    }), [files, isDeleteDialogOpen, isDeleting, handleFileDelete]);


    function handlePaginationReset() {
        setShouldResetPagination(false);
    }

    const initiateDownloadFolder = async () => {
        if (!folderCid) return;

        try {
            const outputDir = (await open({
                directory: true,
                multiple: false
            })) as string | null;

            if (!outputDir) {
                return;
            }

            setSelectedOutputDir(outputDir);

            if (isPrivateFolder) {
                setEncryptionKeyError(null);
                setIsEncryptionDialogOpen(true);
            } else {
                await downloadFolder(outputDir, null);
            }
        } catch (error) {
            console.error("Error selecting download location:", error);
            toast.error(
                `Failed to select download location: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    };

    const downloadFolder = async (
        outputDir: string,
        encryptionKey: string | null
    ) => {
        if (!folderCid || !outputDir) return;

        setIsDownloading(true);
        const result = await downloadIpfsFolder({
            folderCid,
            folderName,
            polkadotAddress: polkadotAddress ?? "",
            isPrivate: isPrivateFolder,
            encryptionKey,
            outputDir,
        });

        if (result && !result.success) {
            if (
                result.error === "INVALID_KEY" ||
                result.error === "INVALID_KEY_FORMAT"
            ) {
                setEncryptionKeyError(
                    result.message || "Incorrect encryption key. Please try again."
                );
                setIsEncryptionDialogOpen(true);
                setIsDownloading(false);
                return;
            }
            toast.error(
                `Failed to download folder: ${result.message || "Unknown error"}`
            );
        } else if (result && result.success) {
            setIsEncryptionDialogOpen(false);
        }
        setIsDownloading(false);
    };

    const handleEncryptedDownload = async (encryptionKey: string | null) => {
        if (!selectedOutputDir) return;
        if (encryptionKey) {
            const savedKeys = await invoke<Array<{ id: number; key: string }>>(
                "get_encryption_keys"
            );

            const keyExists = savedKeys.some((k) => k.key === encryptionKey);

            if (!keyExists) {
                return setEncryptionKeyError(
                    "Incorrect encryption key. Please try again with a correct one."
                );
            }
        }
        await downloadFolder(selectedOutputDir, encryptionKey);
    };

    const handleApplyFilters = useCallback(
        (
            fileTypes: FileTypes[],
            date: string,
            fileSize: number,
            sizeUnit: string
        ) => {
            setSelectedFileTypes(fileTypes);
            setSelectedDate(date);
            setSelectedFileSize(fileSize);
            setSelectedSizeUnit(sizeUnit);
            setIsFilterOpen(false);
            setShouldResetPagination(true);
        },
        []
    );

    const handleResetFilters = useCallback(() => {
        setSelectedFileTypes([]);
        setSelectedDate("");
        setSelectedFileSize(0);
        setSelectedSizeUnit("GB");
        setShouldResetPagination(true);
    }, []);

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

    return (
        <div className="container mx-auto py-8 px-4">
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-2">
                    <Link
                        className="flex gap-2 font-semibold text-lg items-center"
                        href="/files"
                    >
                        <Icons.ArrowLeft className="size-5 text-grey-10" />
                        Back
                    </Link>
                </div>

                <div className="flex items-center gap-4">
                    <RefreshButton
                        onClick={handleRefresh}
                        refetching={isRefreshing}
                    />

                    <div className="">
                        <SearchInput
                            className="h-9"
                            value={searchTerm}
                            onChange={handleSearchChange}
                            placeholder="Search files..."
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
                            className="flex justify-center items-center p-1 cursor-pointer bg-white text-grey-70 rounded"
                            onClick={() => setIsFilterOpen(true)}
                            aria-label="Filter"
                        >
                            <Icons.Filter className="size-5" />
                            {activeFilters.length > 0 && (
                                <span className="ml-1 p-1 bg-primary-100 text-primary-30 border border-primary-80 text-xs rounded min-w-4 h-4 flex items-center justify-center">
                                    {activeFilters.length}
                                </span>
                            )}
                        </button>
                    </div>

                    <AddFileToFolderButton
                        ref={addButtonRef}
                        className="h-9"
                        folderCid={folderCid}
                        folderName={folderName}
                        isPrivateFolder={isPrivateFolder}
                        onFileAdded={handleRefresh}
                    />

                    <button
                        onClick={initiateDownloadFolder}
                        disabled={isDownloading}
                        className={cn(
                            "flex items-center justify-center gap-1 h-9 px-4 py-2 rounded bg-grey-90 text-grey-10 hover:bg-grey-80 transition-colors",
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

            {activeFilters.length > 0 && (
                <FilterChips
                    filters={activeFilters}
                    onRemoveFilter={handleRemoveFilter}
                    onOpenFilterDialog={() => setIsFilterOpen(true)}
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
                        <div className="flex flex-col items-center justify-center py-16 bg-grey-95 rounded-lg">
                            <Icons.Folder className="size-12 text-grey-60 mb-4" />
                            <h3 className="text-lg font-medium text-grey-30 mb-1">
                                Empty Folder
                            </h3>
                            <p className="text-grey-50 text-sm">
                                This folder does not contain any files.
                            </p>
                        </div>
                    ) : (
                        <FilesContent
                            isRecentFiles={false}
                            isLoading={false}
                            isFetching={false}
                            isProcessingTimestamps={false}
                            filteredData={filteredData}
                            displayedData={filteredData}
                            searchTerm={searchTerm}
                            activeFilters={activeFilters}
                            viewMode={viewMode}
                            shouldResetPagination={shouldResetPagination}
                            handlePaginationReset={handlePaginationReset}
                            unpinnedFiles={null}
                            isUnpinnedOpen={false}
                            isFilterOpen={isFilterOpen}
                            setIsFilterOpen={setIsFilterOpen}
                            selectedFileTypes={selectedFileTypes}
                            selectedDate={selectedDate}
                            selectedFileSize={selectedFileSize}
                            selectedSizeUnit={selectedSizeUnit}
                            handleApplyFilters={handleApplyFilters}
                            handleResetFilters={handleResetFilters}
                            isPrivateView={isPrivateFolder}
                        />
                    )}
                </>
            )}

            <DeleteConfirmationDialog
                open={isDeleteDialogOpen}
                onClose={() => {
                    setIsDeleteDialogOpen(false);
                    setFileToDelete(null);
                }}
                onBack={() => {
                    setIsDeleteDialogOpen(false);
                    setFileToDelete(null);
                }}
                onDelete={handleFileDelete}
                button={isDeleting ? "Deleting..." : "Delete File"}
                text={`Are you sure you want to delete\n${fileToDelete?.name ? "\n" + fileToDelete.name : ""}`}
                heading="Delete File"
                disableButton={isDeleting}
            />

            <EncryptionKeyDialog
                open={isEncryptionDialogOpen}
                onClose={() => {
                    setIsEncryptionDialogOpen(false);
                    setEncryptionKeyError(null);
                    setSelectedOutputDir(null);
                }}
                onDownload={handleEncryptedDownload}
                keyError={encryptionKeyError}
            />
        </div>
    );
}
