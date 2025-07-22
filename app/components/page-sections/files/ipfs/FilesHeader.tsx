"use client";

import { FC } from "react";
import Link from "next/link";
import { Icons, RefreshButton, SearchInput } from "@/components/ui";
import { cn } from "@/lib/utils";
import AddButton from "./AddFileButton";
import StorageStateList from "./storage-stats";
import { ActiveFilter } from "@/lib/utils/fileFilterUtils";
import FilterChips from "./filter-chips";

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
    addButtonRef: React.RefObject<{ openWithFiles(files: FileList): void } | null>;
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
}) => {
    return (
        <>
            <div className="flex items-center justify-between w-full gap-6 flex-wrap">
                {isRecentFiles ? (
                    <h2 className="text-lg font-medium text-grey-10">Recent Files</h2>
                ) : (
                    <div className="flex items-center gap-4">
                        <StorageStateList
                            storageUsed={formattedStorageSize}
                            numberOfFiles={allFilteredDataLength || 0}
                        />
                    </div>
                )}
                <div className="flex items-center gap-x-4">
                    <RefreshButton
                        refetching={isRefetching || isFetching}
                        onClick={() => refetchUserFiles()}
                    />

                    {!isRecentFiles && (
                        <div className="">
                            <SearchInput
                                className="h-9"
                                value={searchTerm}
                                onChange={handleSearchChange}
                            />
                        </div>
                    )}

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
                    {isRecentFiles && (
                        <Link
                            href="/files"
                            className="px-4 py-2.5 items-center flex bg-grey-90 rounded hover:bg-primary-50 hover:text-white active:bg-primary-70 active:text-white text-grey-10 leading-5 text-[14px] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary-50"
                        >
                            View All Files
                            <Icons.ArrowRight className="size-[14px] ml-1" />
                        </Link>
                    )}
                    {!isRecentFiles && (
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
        </>
    );
};

export default FilesHeader;
