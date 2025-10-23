import React from "react";
import { Icons } from "@/components/ui";
import { cn } from "@/lib/utils";

interface SyncingLoaderProps {
    isRecentFiles?: boolean;
    message?: string;
}

const SyncingLoader: React.FC<SyncingLoaderProps> = ({
    isRecentFiles = false,
    message = "Syncing has started..."
}) => {
    console.log("[SyncingLoader] Rendering with message:", message);

    return (
        <div
            className={cn("w-full p-6 flex items-center justify-center", {
                "h-[80vh]": !isRecentFiles,
                "h-[150px]": isRecentFiles,
            })}
        >
            <div className="flex flex-col items-center justify-center">
                <div className="size-12 flex items-center justify-center mb-3">
                    <Icons.Refresh className="size-8 text-primary-50 animate-spin" />
                </div>
                <p className="text-center text-grey-60 max-w-[240px] text-sm font-medium">
                    {message}
                </p>
                <p className="text-center text-grey-70 max-w-[240px] text-xs mt-1">
                    Please wait while we sync your files...
                </p>
            </div>
        </div>
    );
};

export default SyncingLoader;