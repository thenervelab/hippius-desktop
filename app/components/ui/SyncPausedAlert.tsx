"use client";

import React from "react";
import { AlertTriangle, Construction } from "lucide-react";
import { cn } from "@/lib/utils";

// Global constant to control sync pause state
// Set to false to re-enable sync functionality
export const IS_SYNC_PAUSED = true;

export const SYNC_PAUSED_MESSAGE = {
    title: "Sync Engine Temporarily Paused",
    description:
        "We're transitioning to a new, more performant sync engine (Arion). Sync functionality will be restored in the coming days.",
    shortDescription:
        "We're transitioning to a new, more performant sync engine (Arion). Coming back soon!",
};

interface SyncPausedAlertProps {
    className?: string;
    variant?: "banner" | "inline" | "compact";
    showIcon?: boolean;
}

export const SyncPausedAlert: React.FC<SyncPausedAlertProps> = ({
    className,
    variant = "banner",
    showIcon = true,
}) => {
    if (!IS_SYNC_PAUSED) return null;

    if (variant === "compact") {
        return (
            <div
                className={cn(
                    "flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-amber-800",
                    className
                )}
            >
                {showIcon && <AlertTriangle className="size-4 flex-shrink-0" />}
                <span className="text-sm font-medium">
                    {SYNC_PAUSED_MESSAGE.shortDescription}
                </span>
            </div>
        );
    }

    if (variant === "inline") {
        return (
            <div
                className={cn(
                    "flex items-start gap-3 p-3 bg-amber-50 border border-amber-200 rounded-lg",
                    className
                )}
            >
                {showIcon && (
                    <div className="flex-shrink-0 mt-0.5">
                        <Construction className="size-5 text-amber-600" />
                    </div>
                )}
                <div className="flex-1">
                    <p className="text-sm font-medium text-amber-800">
                        {SYNC_PAUSED_MESSAGE.title}
                    </p>
                    <p className="text-xs text-amber-700 mt-1">
                        {SYNC_PAUSED_MESSAGE.shortDescription}
                    </p>
                </div>
            </div>
        );
    }

    // Default banner variant
    return (
        <div
            className={cn(
                "flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-lg",
                className
            )}
        >
            {showIcon && (
                <div className="flex-shrink-0 mt-0.5">
                    <Construction className="size-5 text-amber-600" />
                </div>
            )}
            <div className="flex-1">
                <p className="text-sm font-semibold text-amber-800">
                    {SYNC_PAUSED_MESSAGE.title}
                </p>
                <p className="text-sm text-amber-700 mt-1">
                    {SYNC_PAUSED_MESSAGE.description}
                </p>
            </div>
        </div>
    );
};

// Hook to check if sync is paused (for conditional logic in components)
export const useSyncPaused = () => {
    return {
        isSyncPaused: IS_SYNC_PAUSED,
        message: SYNC_PAUSED_MESSAGE,
    };
};

export default SyncPausedAlert;
