import { FileTypes } from "@/lib/types/fileTypes";
import { formatBytesFromBigInt } from "./formatBytes";

/**
 * Filter criteria for the files page / folder view. Mirrors
 * `FileFilterCriteria` on the Rust side (`src-tauri/src/sync/files.rs`).
 * Every rule (date ranges, size thresholds, search behaviour) lives in
 * Rust — this frontend helper only handles presentation concerns
 * (active-filter chip labels) and threading state into `filter_file_entries`.
 */
export interface FilterCriteria {
    searchTerm: string;
    fileTypes: FileTypes[];
    dateFilter: string;
    fileSize: number;
    fileSizes?: number[];
}

export interface ActiveFilter {
    type: 'fileType' | 'date' | 'fileSize';
    value: string;
    label: string;
    displayValue: string;
}

export const getDateOptions = () => ({
    today: "Today",
    last7days: "Last 7 days",
    last30days: "Last 30 days",
    thisyear: `This year`,
    lastyear: `Last year`,
});

/**
 * Generate the filter-chip display objects shown above the files table.
 * Pure presentation: turns the raw filter state into the localized label
 * strings the chip UI renders. The actual filter application is done by
 * Rust (`filter_file_entries`).
 */
export function generateActiveFilters(
    fileTypes: FileTypes[],
    dateFilter: string,
    fileSize: number,
    fileSizes?: number[]
): ActiveFilter[] {
    const activeFilters: ActiveFilter[] = [];
    const dateOptions = getDateOptions();

    fileTypes.forEach(type => {
        activeFilters.push({
            type: 'fileType',
            value: type,
            label: 'Type:',
            displayValue: type.charAt(0).toUpperCase() + type.slice(1)
        });
    });

    if (dateFilter && dateFilter.trim() !== '') {
        let displayValue: string;

        if (dateFilter.match(/^\d{4}-\d{2}-\d{2}$/)) {
            try {
                const date = new Date(dateFilter);
                const months = [
                    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
                ];
                displayValue = `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
            } catch {
                displayValue = dateFilter;
            }
        } else {
            const currentYear = new Date().getFullYear();
            displayValue = dateOptions[dateFilter as keyof typeof dateOptions] || dateFilter;

            if (dateFilter === 'thisyear') {
                displayValue = `${displayValue} (${currentYear})`;
            } else if (dateFilter === 'lastyear') {
                displayValue = `${displayValue} (${currentYear - 1})`;
            }
        }

        activeFilters.push({
            type: 'date',
            value: dateFilter,
            label: 'Date:',
            displayValue
        });
    }

    if (fileSizes && fileSizes.length > 0) {
        const sizeLabels: Record<number, string> = {
            1: 'Small (< 1 MB)',
            [1_000_000]: 'Medium (1 MB - 100 MB)',
            [100_000_000]: 'Large (100 MB - 1 GB)',
            [1_000_000_000]: 'Very Large (> 1 GB)'
        };

        fileSizes.forEach(size => {
            activeFilters.push({
                type: 'fileSize',
                value: String(size),
                label: 'Size:',
                displayValue: sizeLabels[size] || `≥ ${formatBytesFromBigInt(BigInt(size))}`
            });
        });
    } else if (fileSize > 0) {
        activeFilters.push({
            type: 'fileSize',
            value: String(fileSize),
            label: 'File size:',
            displayValue: `≥ ${formatBytesFromBigInt(BigInt(fileSize))}`
        });
    }

    return activeFilters;
}
