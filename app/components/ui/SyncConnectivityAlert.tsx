"use client";

import React from "react";
import { WifiOff, ServerCrash, ShieldAlert, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAtomValue } from "jotai";
import {
  syncEngineHealthAtom,
  type ConnectivityStatusType,
} from "@/app/lib/store/syncAtoms";
import { hasConfiguredDrivesAtom } from "@/app/lib/global-atoms/unpinAtoms";

interface SyncConnectivityAlertProps {
  className?: string;
  variant?: "banner" | "compact";
}

const STATUS_CONFIG: Record<
  Exclude<ConnectivityStatusType, "connected">,
  {
    icon: React.FC<{ className?: string }>;
    title: string;
    description: string;
    /** Outer card: background + border, light + dark. */
    container: string;
    /** Rounded icon chip: tint + icon color, light + dark. */
    iconWrap: string;
    /** Title text color, light + dark. */
    titleColor: string;
    /** Description text color, light + dark. */
    descColor: string;
  }
> = {
  network_offline: {
    icon: WifiOff,
    title: "You appear to be offline",
    description:
      "Files won\u2019t sync until your connection is restored. Your local files are safe.",
    container:
      "border-orange-200/70 bg-orange-50 dark:border-orange-400/20 dark:bg-orange-500/[0.08]",
    iconWrap:
      "bg-orange-100 text-orange-600 dark:bg-orange-500/15 dark:text-orange-400",
    titleColor: "text-orange-900 dark:text-orange-200",
    descColor: "text-orange-700/90 dark:text-orange-300/75",
  },
  server_unreachable: {
    icon: ServerCrash,
    title: "Sync server unreachable",
    description:
      "The sync server is currently unreachable. Your files are safe locally and will sync when the server is back.",
    container:
      "border-orange-200/70 bg-orange-50 dark:border-orange-400/20 dark:bg-orange-500/[0.08]",
    iconWrap:
      "bg-orange-100 text-orange-600 dark:bg-orange-500/15 dark:text-orange-400",
    titleColor: "text-orange-900 dark:text-orange-200",
    descColor: "text-orange-700/90 dark:text-orange-300/75",
  },
  auth_expired: {
    icon: ShieldAlert,
    title: "Session expired",
    description:
      "Your session has expired. Please re-authenticate to resume syncing.",
    container:
      "border-red-200/70 bg-red-50 dark:border-red-400/20 dark:bg-red-500/[0.08]",
    iconWrap:
      "bg-red-100 text-red-600 dark:bg-red-500/15 dark:text-red-400",
    titleColor: "text-red-900 dark:text-red-200",
    descColor: "text-red-700/90 dark:text-red-300/75",
  },
  degraded: {
    icon: Clock,
    title: "Sync server responding slowly",
    description:
      "The sync server is responding slowly. Syncing may be delayed.",
    container:
      "border-amber-200/70 bg-amber-50 dark:border-amber-400/20 dark:bg-amber-500/[0.08]",
    iconWrap:
      "bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400",
    titleColor: "text-amber-900 dark:text-amber-200",
    descColor: "text-amber-700/90 dark:text-amber-300/75",
  },
};

/**
 * Alert banner shown when the sync engine detects connectivity issues.
 * Auto-dismisses when connectivity is restored.
 *
 * Only shows if sync has been configured and status is not "connected".
 */
export const SyncConnectivityAlert: React.FC<SyncConnectivityAlertProps> = ({
  className,
  variant = "banner",
}) => {
  const health = useAtomValue(syncEngineHealthAtom);
  const isSyncConfigured = useAtomValue(hasConfiguredDrivesAtom);

  if (health.status === "connected" || !isSyncConfigured) return null;

  const config = STATUS_CONFIG[health.status];
  const Icon = config.icon;

  if (variant === "compact") {
    return (
      <div
        className={cn(
          "flex items-center gap-2.5 rounded-xl border px-3 py-2 mb-4",
          config.container,
          className,
        )}
      >
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-lg",
            config.iconWrap,
          )}
        >
          <Icon className="size-4" />
        </span>
        <span className={cn("text-sm font-semibold", config.titleColor)}>
          {config.title}
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl border px-4 py-3 mb-4",
        config.container,
        className,
      )}
    >
      <div
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg",
          config.iconWrap,
        )}
      >
        <Icon className="size-[18px]" />
      </div>
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm font-semibold", config.titleColor)}>
          {config.title}
        </p>
        <p className={cn("text-xs mt-0.5", config.descColor)}>
          {config.description}
        </p>
      </div>
    </div>
  );
};

export default SyncConnectivityAlert;
