import React from "react";
import NoEntriesFound from "@/components/ui/NoEntriesFound";

interface NoMatchingResultsProps {
    searchTerm?: string;
    hasActiveFilters?: boolean;
    entityType?: "file" | "sub-token" | "master-token" | string;
}

/**
 * Empty state shown above the files table when an active search or
 * filter returns zero rows. Mirrors the web console: same card-style
 * layout as the "no entries yet" state (rendered via the shared
 * `NoEntriesFound` component) instead of the previous standalone
 * graphsheet+icon block. Keeps the two empty states visually
 * consistent so the user only learns one pattern.
 */
const NoMatchingResults: React.FC<NoMatchingResultsProps> = ({
    searchTerm,
    hasActiveFilters,
    entityType = "file",
}) => {
    const entityName = (() => {
        switch (entityType) {
            case "sub-token":
                return "sub tokens";
            case "master-token":
                return "master tokens";
            case "file":
            default:
                return "files";
        }
    })();

    const description = (() => {
        if (searchTerm && hasActiveFilters) {
            return `Try clearing your search or adjusting filters to see more ${entityName}.`;
        }
        if (searchTerm) {
            return `No ${entityName} found matching "${searchTerm}". Try a different search term.`;
        }
        if (hasActiveFilters) {
            return `Try another filter, or use other filter options to find ${entityName}.`;
        }
        return `No ${entityName} found.`;
    })();

    return (
        <NoEntriesFound
            title="No matching results"
            description={description}
            className="p-4 sm:p-8 2xl:p-16"
        />
    );
};

export default NoMatchingResults;
