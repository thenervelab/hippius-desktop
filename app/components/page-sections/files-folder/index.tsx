"use client";

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { Icons } from "@/components/ui";
import { cn } from "@/lib/utils";
import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";
import FilesContent from "@/components/page-sections/files/ipfs/FilesContent";
import { toast } from "sonner";
import Link from "next/link";
import { ActiveFilter } from "@/lib/utils/fileFilterUtils";
import { FileTypes } from "@/lib/types/fileTypes";
import { filterFiles, generateActiveFilters } from "@/lib/utils/fileFilterUtils";
import { SearchInput } from "@/components/ui";
import FilterChips from "@/components/page-sections/files/ipfs/filter-chips";

interface FileEntry {
    file_name: string;
    file_size: number;
    cid: string;
}

interface FolderViewProps {
    folderCid: string;
    folderName?: string;
}

export default function FolderView({ folderCid, folderName = "Folder" }: FolderViewProps) {
    const { polkadotAddress } = useWalletAuth();
    const [files, setFiles] = useState<FormattedUserIpfsFile[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [viewMode, setViewMode] = useState<"list" | "card">("list");
    const [isDownloading, setIsDownloading] = useState(false);

    // State needed for FilesContent integration
    const [searchTerm, setSearchTerm] = useState("");
    const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
    const [shouldResetPagination, setShouldResetPagination] = useState(false);
    const [selectedFileTypes, setSelectedFileTypes] = useState<FileTypes[]>([]);
    const [selectedDate, setSelectedDate] = useState("");
    const [selectedFileSize, setSelectedFileSize] = useState(0);
    const [selectedSizeUnit, setSelectedSizeUnit] = useState("GB");
    const [isFilterOpen, setIsFilterOpen] = useState(false);

    // Apply filters to the files
    const filteredData = useMemo(() => {
        return filterFiles(files, {
            searchTerm,
            fileTypes: selectedFileTypes,
            dateFilter: selectedDate,
            fileSize: selectedFileSize
        });
    }, [files, searchTerm, selectedFileTypes, selectedDate, selectedFileSize]);

    // Update active filters whenever filter settings change
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

    useEffect(() => {
        if (!folderCid) return;

        const loadFolderContents = async () => {
            try {
                setIsLoading(true);

                // Get folder contents
                const fileEntries = await invoke<FileEntry[]>("list_folder_contents", {
                    folderMetadataCid: folderCid
                });

                // Convert FileEntry to FormattedUserIpfsFile format
                const formattedFiles = fileEntries.map((entry): FormattedUserIpfsFile => ({
                    cid: entry.cid,
                    name: entry.file_name,
                    size: entry.file_size,
                    type: entry.file_name.split('.').pop() || "unknown",
                    isAssigned: true,
                    source: folderName,
                    createdAt: Date.now(),
                    minerIds: [],
                    lastChargedAt: Date.now(),
                }));

                setFiles(formattedFiles);
            } catch (error) {
                console.error("Error loading folder contents:", error);
                toast.error(`Failed to load folder contents: ${error instanceof Error ? error.message : String(error)}`);
            } finally {
                setIsLoading(false);
            }
        };

        loadFolderContents();
    }, [folderCid, folderName]);

    function handlePaginationReset() {
        setShouldResetPagination(false);
    }

    const handleDownloadFolder = async () => {
        if (!folderCid) return;

        try {
            setIsDownloading(true);

            // Ask user to select download location
            const outputDir = await open({
                directory: true,
                multiple: false,
            }) as string | null;

            if (!outputDir) {
                setIsDownloading(false);
                return;
            }

            toast.info("Downloading folder...");

            // Use the encrypted download method
            await invoke("download_and_decrypt_folder", {
                accountId: polkadotAddress,
                folderMetadataCid: folderCid,
                folderName: folderName,
                outputDir: outputDir,
                encryptionKey: null,
            });

            toast.success("Folder downloaded successfully!");
        } catch (error) {
            console.error("Error downloading folder:", error);
            toast.error(`Failed to download folder: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setIsDownloading(false);
        }
    };

    // Handle applying filters
    const handleApplyFilters = useCallback(
        (fileTypes: FileTypes[], date: string, fileSize: number, sizeUnit: string) => {
            setSelectedFileTypes(fileTypes);
            setSelectedDate(date);
            setSelectedFileSize(fileSize);
            setSelectedSizeUnit(sizeUnit);
            setIsFilterOpen(false);
            setShouldResetPagination(true);
        },
        []
    );

    // Handle resetting filters
    const handleResetFilters = useCallback(() => {
        setSelectedFileTypes([]);
        setSelectedDate("");
        setSelectedFileSize(0);
        setSelectedSizeUnit("GB");
        setShouldResetPagination(true);
    }, []);

    // Handle search change
    const handleSearchChange = useCallback((value: string) => {
        setSearchTerm(value);
        setShouldResetPagination(true);
    }, []);

    // Handle removing a filter
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

    return (
        <div className="container mx-auto py-8 px-4">
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-2">
                    <Link
                        href="/files"
                        className="flex items-center text-grey-50 hover:text-grey-30"
                    >
                        <Icons.ArrowLeft className="size-4 mr-1" />
                        Back
                    </Link>
                </div>

                <div className="flex items-center gap-4">
                    {/* Search Input */}
                    <div className="">
                        <SearchInput
                            className="h-9"
                            value={searchTerm}
                            onChange={handleSearchChange}
                            placeholder="Search files..."
                        />
                    </div>

                    {/* View Mode Toggle */}
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

                    {/* Filter Button */}
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

                    {/* Download Folder Button */}
                    <button
                        onClick={handleDownloadFolder}
                        disabled={isDownloading}
                        className={cn(
                            "flex items-center justify-center gap-1 h-9 px-4 py-2 rounded bg-primary-50 text-white hover:bg-primary-40 transition-colors",
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

            {/* Active Filters Display */}
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
                            <h3 className="text-lg font-medium text-grey-30 mb-1">Empty Folder</h3>
                            <p className="text-grey-50 text-sm">This folder does not contain any files.</p>
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
                            isPrivateView={false}
                        />
                    )}
                </>
            )}
        </div>
    );
}
