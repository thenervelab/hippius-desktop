import { formatBytesFromBigInt } from "./formatBytes";
import { getFileExtensions, type FileExtension } from "./fileTypeMapper";
import type { DateRange } from "@/app/lib/types/dateRange";

/**
 * Filter criteria for the files page / folder view. Mirrors
 * `FileFilterCriteria` on the Rust side (`src-tauri/src/sync/files.rs`).
 * Every rule (date ranges, size thresholds, search behaviour) lives in
 * Rust — this frontend helper only handles presentation concerns
 * (active-filter chip labels) and threading state into
 * `filter_file_entries` / `search_user_files_recursive`.
 */
export interface FilterCriteria {
    searchTerm: string;
    /** Specific extension to match (e.g. "mp4"). Console-equivalent. */
    fileExtension?: FileExtension;
    /** Inclusive date window — `{from, to}` are YYYY-MM-DD. */
    dateRange?: DateRange;
    fileSize: number;
    fileSizes?: number[];
}

export interface ActiveFilter {
    type: 'fileExtension' | 'dateRange' | 'fileSize' | 'excludedOnly';
    value: string;
    label: string;
    displayValue: string;
}

const MONTHS_SHORT = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Format a YYYY-MM-DD string as "Mar 5, 2026" without timezone shifts. */
function formatYmd(ymd: string): string {
    const parts = ymd.split('-');
    if (parts.length !== 3) return ymd;
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    if (
        Number.isNaN(year) ||
        Number.isNaN(month) ||
        Number.isNaN(day) ||
        month < 0 ||
        month > 11
    ) {
        return ymd;
    }
    return `${MONTHS_SHORT[month]} ${day}, ${year}`;
}

/**
 * Generate the filter-chip display objects shown above the files table.
 * Pure presentation: turns the raw filter state into the localized label
 * strings the chip UI renders. The actual filter application is done by
 * Rust (`filter_file_entries`).
 */
export function generateActiveFilters(
    fileExtension: FileExtension | undefined,
    dateRange: DateRange | undefined,
    fileSize: number,
    fileSizes?: number[],
    excludedOnly?: boolean,
): ActiveFilter[] {
    const activeFilters: ActiveFilter[] = [];

    if (fileExtension) {
        const ext = getFileExtensions().find((e) => e.value === fileExtension);
        activeFilters.push({
            type: 'fileExtension',
            value: fileExtension,
            label: 'Type',
            displayValue: ext?.label ?? fileExtension.toUpperCase(),
        });
    }

    if (dateRange?.from) {
        const fromLabel = formatYmd(dateRange.from);
        const toLabel = dateRange.to ? formatYmd(dateRange.to) : fromLabel;
        const displayValue =
            dateRange.from === dateRange.to ? fromLabel : `${fromLabel} - ${toLabel}`;
        activeFilters.push({
            type: 'dateRange',
            value: `${dateRange.from}_${dateRange.to ?? dateRange.from}`,
            label: 'Date',
            displayValue,
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
                label: 'Size',
                displayValue: sizeLabels[size] || `≥ ${formatBytesFromBigInt(BigInt(size))}`
            });
        });
    } else if (fileSize > 0) {
        activeFilters.push({
            type: 'fileSize',
            value: String(fileSize),
            label: 'File size',
            displayValue: `≥ ${formatBytesFromBigInt(BigInt(fileSize))}`
        });
    }

    if (excludedOnly) {
        activeFilters.push({
            type: 'excludedOnly',
            value: 'excluded',
            label: 'Status',
            displayValue: 'Excluded',
        });
    }

    return activeFilters;
}
