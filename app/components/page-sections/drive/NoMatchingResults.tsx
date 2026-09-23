import React from "react";
import NoEntriesFound from "@/components/ui/NoEntriesFound";
import { SEARCH_TERM_TOO_SHORT_HINT } from "@/app/lib/utils/searchTerm";

interface NoMatchingResultsProps {
    searchTerm?: string;
    hasActiveFilters?: boolean;
    /** The typed term is below the server search's minimum, so nothing was
     *  searched. Says so instead of claiming there were no matches. */
    searchTermTooShort?: boolean;
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
    searchTermTooShort = false,
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

    if (searchTermTooShort) {
        return (
            <NoEntriesFound
                title="Keep typing"
                description={SEARCH_TERM_TOO_SHORT_HINT}
                className="p-4 sm:p-8 2xl:p-16"
            />
        );
    }

    return (
        <NoEntriesFound
            title="No matching results"
            description={description}
            className="p-4 sm:p-8 2xl:p-16"
        />
    );
};

export default NoMatchingResults;
