import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";
import { FileTypes } from "@/lib/types/fileTypes";
import { formatBytesFromBigInt } from "./formatBytes";
import { getFilePartsFromFileName } from "./getFilePartsFromFileName";
import { getFileTypeFromExtension } from "./getTileTypeFromExtension";

export interface FilterCriteria {
    searchTerm: string;
    fileTypes: FileTypes[];
    dateFilter: string;
    fileSize: number;
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
    files: Array<FormattedUserIpfsFile & { timestamp?: Date | null }>,
    criteria: FilterCriteria
): Array<FormattedUserIpfsFile & { timestamp?: Date | null }> {
    if (!files.length) return [];

    let result = [...files];

    // Apply search filter if search term exists
    if (criteria.searchTerm.trim()) {
        const search = criteria.searchTerm.toLowerCase().trim();
        result = result.filter(file =>
            file.name.toLowerCase().includes(search)
        );
    }

    // Apply file type filter if any types are selected
    if (criteria.fileTypes.length > 0) {
        result = result.filter(file => {
            const { fileFormat } = getFilePartsFromFileName(file.name);
            const fileType = getFileTypeFromExtension(fileFormat || null);
            return criteria.fileTypes.includes(fileType as FileTypes);
        });
    }

    // Apply date filter if selected and files have timestamps
    if (criteria.dateFilter) {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        result = result.filter(file => {
            // Skip files without timestamps
            if (!file.timestamp) return false;

            const fileDate = file.timestamp;

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

    // Apply file size filter if value is greater than 0
    if (criteria.fileSize > 0) {
        result = result.filter(file => {
            if (!file.size) return false; // Skip files without size info
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
    fileSize: number
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
    if (dateFilter) {
        const currentYear = new Date().getFullYear();
        let displayValue = dateOptions[dateFilter as keyof typeof dateOptions];

        // Add year info for thisyear and lastyear filters
        if (dateFilter === 'thisyear') {
            displayValue = `${displayValue} (${currentYear})`;
        } else if (dateFilter === 'lastyear') {
            displayValue = `${displayValue} (${currentYear - 1})`;
        }

        activeFilters.push({
            type: 'date',
            value: dateFilter,
            label: 'Date upload:',
            displayValue
        });
    }

    // Add file size filter
    if (fileSize > 0) {
        activeFilters.push({
            type: 'fileSize',
            value: String(fileSize),
            label: 'File size:',
            displayValue: `≥ ${formatBytesFromBigInt(BigInt(fileSize))}`
        });
    }

    return activeFilters;
}
