"use client";

import React from "react";
import { Loader2, PauseCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAtomValue } from "jotai";
import { syncEngineStatusAtom } from "@/app/lib/global-atoms/unpinAtoms";

interface SyncStoppedAlertProps {
  className?: string;
  variant?: "banner" | "compact";
}

/**
 * Alert banner shown when the user has explicitly stopped syncing
 * or when syncing is in the process of stopping.
 */
export const SyncStoppedAlert: React.FC<SyncStoppedAlertProps> = ({
  className,
  variant = "banner",
}) => {
  const syncStatus = useAtomValue(syncEngineStatusAtom);

  // Only show when sync is stopped or stopping
  if (syncStatus === "active") return null;

  const isStopping = syncStatus === "stopping";

  if (variant === "compact") {
    return (
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-2 rounded-lg",
          isStopping
            ? "bg-amber-50 border border-amber-200 text-amber-800"
            : "bg-orange-50 border border-orange-200 text-orange-800",
          className
        )}
      >
        {isStopping ? (
          <Loader2 className="size-4 flex-shrink-0 animate-spin" />
        ) : (
          <PauseCircle className="size-4 flex-shrink-0" />
        )}
        <span className="text-sm font-medium">
          {isStopping
            ? "Stopping sync... please wait while the current operation finishes."
            : "Syncing is stopped \u2014 files won\u2019t be uploaded until you resume."}
        </span>
      </div>
    );
  }

  // Default banner variant
  return (
    <div
      className={cn(
        "flex items-start gap-3 p-3 rounded-lg",
        isStopping
          ? "bg-amber-50 border border-amber-200"
          : "bg-orange-50 border border-orange-200",
        className
      )}
    >
      <div className="flex-shrink-0 mt-0.5">
        {isStopping ? (
          <Loader2 className="size-5 text-amber-600 animate-spin" />
        ) : (
          <PauseCircle className="size-5 text-orange-600" />
        )}
      </div>
      <div className="flex-1">
        <p className={cn("text-sm font-medium", isStopping ? "text-amber-800" : "text-orange-800")}>
          {isStopping ? "Stopping sync\u2026" : "Syncing is currently stopped"}
        </p>
        <p className={cn("text-xs mt-1", isStopping ? "text-amber-700" : "text-orange-700")}>
          {isStopping
            ? "The sync engine is finishing its current operation. This may take a moment."
            : "Your files are not being synced. Any changes you make won\u2019t be uploaded until you resume syncing from Settings \u2192 File Settings."}
        </p>
      </div>
    </div>
  );
};

export default SyncStoppedAlert;
