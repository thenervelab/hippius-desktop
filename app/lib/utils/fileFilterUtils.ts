import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { FileTypes } from "@/lib/types/fileTypes";
import { formatBytesFromBigInt } from "./formatBytes";
import { getFilePartsFromFileName } from "./getFilePartsFromFileName";
import { getFileTypeFromExtension } from "./getTileTypeFromExtension";

export interface FilterCriteria {
    searchTerm: string;
    fileTypes: FileTypes[];
    dateFilter: string;
    fileSize: number;
    fileSizes?: number[]; // New array-based file size filter
}

export interface ActiveFilter {
    type: 'fileType' | 'date' | 'fileSize';
    value: string;
    label: string;
    displayValue: string;
}

// Date filter options with their labels - using dynamic years
export const getDateOptions = () => {
    return {
        today: "Today",
        last7days: "Last 7 days",
        last30days: "Last 30 days",
        thisyear: `This year`,
        lastyear: `Last year`,
    };
};

/**
 * Filter files based on specified criteria
 * This function assumes the files have a 'timestamp' property added by enrichFilesWithTimestamps
 */
export function filterFiles(
    files: Array<FormattedUserFile & { timestamp?: Date | null }>,
    criteria: FilterCriteria
): Array<FormattedUserFile & { timestamp?: Date | null }> {
    // Handle undefined or null files
    if (!files || !files.length) return [];



    let result = [...files];

    // Apply search filter if search term exists
    if (criteria.searchTerm.trim()) {
        const search = criteria.searchTerm.toLowerCase().trim();
        result = result.filter(file =>
            file.name.toLowerCase().includes(search) || file.arionHash.toLowerCase().includes(search)
        );
    }

    // Apply file type filter if any types are selected
    if (criteria.fileTypes.length > 0) {
        result = result.filter(file => {
            const { fileFormat } = getFilePartsFromFileName(file.name);
            let fileType = getFileTypeFromExtension(fileFormat || null);
            if (file.isFolder) {
                fileType = "folder";
            }
            return criteria.fileTypes.includes(fileType as FileTypes);
        });
    }

    // Apply date filter if selected
    if (criteria.dateFilter && criteria.dateFilter.trim() !== '') {
        result = result.filter(file => {
            let fileDate: Date;

            if (file.timestamp) {
                // Use timestamp if available (already a Date object)
                fileDate = file.timestamp;
            } else if (file.createdAt) {
                // Convert timestamp using the same logic as FormattedTimestamp component
                const isRecentTimestamp = (file.createdAt > 946684800 && file.createdAt < 4102444800); // Between 2000-01-01 and 2100-01-01

                // Convert timestamp to milliseconds for JavaScript Date
                // Unix timestamps are in seconds, JavaScript needs milliseconds
                fileDate = new Date(isRecentTimestamp ? file.createdAt * 1000 : file.createdAt);

                // If the date is invalid or extremely old/future, exclude from filtering
                if (isNaN(fileDate.getTime()) || fileDate.getFullYear() < 2000 || fileDate.getFullYear() > 2100) {
                    return false;
                }
            } else {
                // If no date info available, exclude from date filtering
                return false;
            }            // Handle custom date selection (YYYY-MM-DD format)
            if (criteria.dateFilter.match(/^\d{4}-\d{2}-\d{2}$/)) {
                const selectedDate = new Date(criteria.dateFilter);
                selectedDate.setHours(0, 0, 0, 0);
                const nextDay = new Date(selectedDate);
                nextDay.setDate(nextDay.getDate() + 1);

                return fileDate >= selectedDate && fileDate < nextDay;
            }

            // Handle predefined date ranges (legacy support)
            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

            switch (criteria.dateFilter) {
                case 'today':
                    return fileDate >= today;

                case 'last7days': {
                    const sevenDaysAgo = new Date();
                    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
                    return fileDate >= sevenDaysAgo;
                }

                case 'last30days': {
                    const thirtyDaysAgo = new Date();
                    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
                    return fileDate >= thirtyDaysAgo;
                }

                case 'thisyear': {
                    const firstDayOfYear = new Date(now.getFullYear(), 0, 1);
                    return fileDate >= firstDayOfYear;
                }

                case 'lastyear': {
                    const firstDayLastYear = new Date(now.getFullYear() - 1, 0, 1);
                    const lastDayLastYear = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59);
                    return fileDate >= firstDayLastYear && fileDate <= lastDayLastYear;
                }

                default:
                    return true;
            }
        });
    }

    // Apply file size filter - prioritize array-based filter if available
    if (criteria.fileSizes && criteria.fileSizes.length > 0) {
        result = result.filter(file => {
            if (!file.size) {
                return false; // Skip files without size info
            }
            const fileSize = BigInt(file.size);

            const matches = criteria.fileSizes!.some(threshold => {
                let isMatch = false;
                // Define size ranges based on predefined options
                if (threshold === 1) { // Small: < 1 MB
                    isMatch = fileSize < BigInt(1024 * 1024);
                } else if (threshold === 1024 * 1024) { // Medium: 1 MB - 100 MB
                    isMatch = fileSize >= BigInt(1024 * 1024) && fileSize <= BigInt(100 * 1024 * 1024);
                } else if (threshold === 100 * 1024 * 1024) { // Large: 100 MB - 1 GB
                    isMatch = fileSize > BigInt(100 * 1024 * 1024) && fileSize <= BigInt(1024 * 1024 * 1024);
                } else if (threshold === 1024 * 1024 * 1024) { // Very Large: > 1 GB
                    isMatch = fileSize > BigInt(1024 * 1024 * 1024);
                } else {
                    // Handle custom sizes: use >= threshold
                    isMatch = fileSize >= BigInt(threshold);
                }
                return isMatch;
            });

            return matches;
        });
    } else if (criteria.fileSize > 0) {
        // Fallback to original file size filter
        result = result.filter(file => {
            if (!file.size) return false;
            return BigInt(file.size) >= BigInt(criteria.fileSize);
        });
    }

    return result;
}

/**
 * Generate active filters based on current filter selections
 */
export function generateActiveFilters(
    fileTypes: FileTypes[],
    dateFilter: string,
    fileSize: number,
    fileSizes?: number[]
): ActiveFilter[] {
    const activeFilters: ActiveFilter[] = [];
    const dateOptions = getDateOptions();

    // Add file type filters
    fileTypes.forEach(type => {
        activeFilters.push({
            type: 'fileType',
            value: type,
            label: 'Type:',
            displayValue: type.charAt(0).toUpperCase() + type.slice(1)
        });
    });

    // Add date filter
    if (dateFilter && dateFilter.trim() !== '') {
        let displayValue: string;

        // Check if it's a custom date (YYYY-MM-DD format)
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
            // Handle predefined date options
            const currentYear = new Date().getFullYear();
            displayValue = dateOptions[dateFilter as keyof typeof dateOptions] || dateFilter;

            // Add year info for thisyear and lastyear filters
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

    // Add file size filters - prioritize array-based filter
    if (fileSizes && fileSizes.length > 0) {
        const sizeLabels: Record<number, string> = {
            1: 'Small (< 1 MB)',
            [1024 * 1024]: 'Medium (1 MB - 100 MB)',
            [100 * 1024 * 1024]: 'Large (100 MB - 1 GB)',
            [1024 * 1024 * 1024]: 'Very Large (> 1 GB)'
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
        // Fallback to original file size filter
        activeFilters.push({
            type: 'fileSize',
            value: String(fileSize),
            label: 'File size:',
            displayValue: `≥ ${formatBytesFromBigInt(BigInt(fileSize))}`
        });
    }

    return activeFilters;
}
