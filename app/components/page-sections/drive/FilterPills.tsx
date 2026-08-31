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
  excludedOnly?: boolean;
  onFileExtensionChange: (extension: FileExtension | undefined) => void;
  onDateRangeChange: (range: DateRange | undefined) => void;
  onFileSizesChange: (sizes: number[]) => void;
  onExcludedOnlyChange?: (excludedOnly: boolean) => void;
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
  excludedOnly = false,
  onFileExtensionChange,
  onDateRangeChange,
  onFileSizesChange,
  onExcludedOnlyChange,
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

      {onExcludedOnlyChange && (
        <button
          type="button"
          aria-pressed={excludedOnly}
          onClick={() => onExcludedOnlyChange(!excludedOnly)}
          className={cn(
            "h-8 px-3 rounded-[7px] border font-mono text-[12px] font-medium uppercase tracking-[-0.24px]",
            excludedOnly
              ? "bg-grey-light-700 border-grey-dark-100 text-black-600 dark:bg-black-300 dark:border-black-300 dark:text-white"
              : "bg-[#fefefe] border-[#e0e0e0] text-black-600 dark:bg-black-primary-bg dark:border-black-300 dark:text-grey-light-200",
          )}
        >
          Excluded
        </button>
      )}
    </div>
  );
};

export default FilterPills;
