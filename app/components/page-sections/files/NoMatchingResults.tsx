import React from "react";
import { Database } from "lucide-react";
import { Graphsheet } from "@/app/components/ui";

interface NoMatchingResultsProps {
    searchTerm?: string;
    hasActiveFilters?: boolean;
    entityType?: "file" | "sub-token" | "master-token" | string;
}

const NoMatchingResults: React.FC<NoMatchingResultsProps> = ({ searchTerm, hasActiveFilters, entityType = "file" }) => {
    const getEntityName = () => {
        switch (entityType) {
            case "sub-token":
                return "sub tokens";
            case "master-token":
                return "master tokens";
            case "file":
            default:
                return "files";
        }
    };

    const getMessage = () => {
        const entity = getEntityName();

        if (searchTerm && hasActiveFilters) {
            return `Try clearing your search or adjusting filters to see more ${entity}.`;
        } else if (searchTerm) {
            return `No ${entity} found matching "${searchTerm}". Try a different search term.`;
        } else if (hasActiveFilters) {
            return `Try another filter, or use other filter options to find ${entity}.`;
        } else {
            return `No ${entity} found.`;
        }
    };

    return (
        <div className="min-h-[42.5rem] flex flex-col items-center justify-center">
            <div className="text-2xl font-medium text-grey-10 flex flex-col items-center justify-center pt-4 gap-4">
                <div className="flex items-center sm:justify-center h-[3.5rem] w-[3.5rem] relative">
                    <Graphsheet
                        majorCell={{
                            lineColor: [31, 80, 189, 1],
                            lineWidth: 2,
                            cellDim: 40,
                        }}
                        minorCell={{
                            lineColor: [31, 80, 189, 1],
                            lineWidth: 2,
                            cellDim: 40,
                        }}
                        className="absolute w-full h-full top-0 bottom-0 left-0 duration-300 opacity-30 hidden sm:block"
                    />
                    <div className="bg-white-cloud-gradient-sm absolute w-full h-full" />
                    <div className="flex items-center justify-center h-8 w-8 bg-primary-50 rounded-[0.5rem] relative">
                        <Database className="size-5 text-white" />
                    </div>
                </div>
                <span>No matching results</span>
            </div>

            <div className="flex flex-col items-center justify-center mt-4 max-w-[20rem]">
                <div className="text-sm text-grey-60 font-medium mb-4 text-center">
                    {getMessage()}
                </div>
            </div>
        </div>
    );
};

export default NoMatchingResults;