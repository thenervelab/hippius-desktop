import React from "react";
import { Database } from "lucide-react";
import { Graphsheet } from "@/app/components/ui";

interface NoMatchingResultsProps {
    searchTerm?: string;
    hasActiveFilters?: boolean;
}

const NoMatchingResults: React.FC<NoMatchingResultsProps> = ({ searchTerm, hasActiveFilters }) => {
    const getMessage = () => {
        if (searchTerm && hasActiveFilters) {
            return "Try clearing your search or adjusting filters to see more results.";
        } else if (searchTerm) {
            return "Try clearing your search to see more results.";
        } else if (hasActiveFilters) {
            return "Try another filter, or use other filter options to find a file by type, size, or date.";
        } else {
            return "No files found in this location.";
        }
    };

    return (
        <div className="min-h-[680px] flex flex-col items-center justify-center">
            <div className="text-2xl font-medium text-grey-10 flex flex-col items-center justify-center pt-4 gap-4">
                <div className="flex items-center sm:justify-center h-[56px] w-[56px] relative">
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
                    <div className="flex items-center justify-center h-8 w-8 bg-primary-50 rounded-[8px] relative">
                        <Database className="size-5 text-white" />
                    </div>
                </div>
                <span>No matching results</span>
            </div>

            <div className="flex flex-col items-center justify-center mt-4 max-w-[320px]">
                <div className="text-sm text-grey-60 font-medium mb-4 text-center">
                    {getMessage()}
                </div>
            </div>
        </div>
    );
};

export default NoMatchingResults;