"use client";

import React from "react";
import FileExtensionSelector from "./filter-dialog-content/FileExtensionSelector";
import DateRangeSelector from "./filter-dialog-content/DateRangeSelector";
import EnhancedFileSizeSelector from "./filter-dialog-content/EnhancedFileSizeSelector";
import { cn } from "@/app/lib/utils";
import type { FileExtension } from "@/app/lib/utils/fileTypeMapper";
import type { DateRange } from "@/app/lib/types/dateRange";

interface FilterPillsProps {
  selectedFileExtension?: FileExtension;
  selectedDateRange?: DateRange;
  selectedFileSizes: number[];
  onFileExtensionChange: (extension: FileExtension | undefined) => void;
  onDateRangeChange: (range: DateRange | undefined) => void;
  onFileSizesChange: (sizes: number[]) => void;
  className?: string;
}

/**
 * Filter pills row above the files table. Hosts the three console-style
 * selectors: File Type (specific extension), File Size (range buckets),
 * Date Range. Each selector owns its own dropdown — this component is
 * just a layout wrapper.
 */
const FilterPills: React.FC<FilterPillsProps> = ({
  selectedFileExtension,
  selectedDateRange,
  selectedFileSizes,
  onFileExtensionChange,
  onDateRangeChange,
  onFileSizesChange,
  className = "",
}) => {
  return (
    <div className={cn("flex items-center gap-2 flex-wrap h-8", className)}>
      <FileExtensionSelector
        selectedExtension={selectedFileExtension}
        onExtensionSelect={onFileExtensionChange}
      />

      <EnhancedFileSizeSelector
        selectedSizes={selectedFileSizes}
        onSizesSelect={onFileSizesChange}
      />

      <DateRangeSelector
        selectedRange={selectedDateRange}
        onRangeSelect={onDateRangeChange}
      />
    </div>
  );
};

export default FilterPills;
