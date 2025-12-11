"use client";

import React from "react";
import { FileTypes } from "@/lib/types/fileTypes";
import FileTypeSelector from "./filter-dialog-content/FileTypeSelector";
import DateSelector from "./filter-dialog-content/DateSelector";
import EnhancedFileSizeSelector from "./filter-dialog-content/EnhancedFileSizeSelector";
import { cn } from "@/app/lib/utils";

interface FilterPillsProps {
    selectedFileTypes: FileTypes[];
    selectedDate: string;
    selectedFileSizes: number[];
    onFileTypesChange: (types: FileTypes[]) => void;
    onDateChange: (date: string) => void;
    onFileSizesChange: (sizes: number[]) => void;
    className?: string;
}

const FilterPills: React.FC<FilterPillsProps> = ({
    selectedFileTypes,
    selectedDate,
    selectedFileSizes,
    onFileTypesChange,
    onDateChange,
    onFileSizesChange,
    className = "",
}) => {
    return (
        <div className={cn("flex items-center gap-2 flex-wrap", className)}>
            {/* File Type Filter Pill */}
            <FileTypeSelector
                selectedTypes={selectedFileTypes}
                onTypesSelect={onFileTypesChange}
            />

            {/* File Size Filter Pill */}
            <EnhancedFileSizeSelector
                selectedSizes={selectedFileSizes}
                onSizesSelect={onFileSizesChange}
            />

            {/* Date Filter Pill */}
            <DateSelector
                selectedDate={selectedDate}
                onDateSelect={onDateChange}
            />

        </div>
    );
};

export default FilterPills;