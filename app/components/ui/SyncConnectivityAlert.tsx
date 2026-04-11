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
    bannerBg: string;
    bannerBorder: string;
    titleColor: string;
    descColor: string;
    iconColor: string;
  }
> = {
  network_offline: {
    icon: WifiOff,
    title: "You appear to be offline",
    description:
      "Files won\u2019t sync until your connection is restored. Your local files are safe.",
    bannerBg: "bg-orange-50",
    bannerBorder: "border-orange-200",
    titleColor: "text-orange-800",
    descColor: "text-orange-700",
    iconColor: "text-orange-600",
  },
  server_unreachable: {
    icon: ServerCrash,
    title: "Sync server unreachable",
    description:
      "The sync server is currently unreachable. Your files are safe locally and will sync when the server is back.",
    bannerBg: "bg-orange-50",
    bannerBorder: "border-orange-200",
    titleColor: "text-orange-800",
    descColor: "text-orange-700",
    iconColor: "text-orange-600",
  },
  auth_expired: {
    icon: ShieldAlert,
    title: "Session expired",
    description:
      "Your session has expired. Please re-authenticate to resume syncing.",
    bannerBg: "bg-red-50",
    bannerBorder: "border-red-200",
    titleColor: "text-red-800",
    descColor: "text-red-700",
    iconColor: "text-red-600",
  },
  degraded: {
    icon: Clock,
    title: "Sync server responding slowly",
    description:
      "The sync server is responding slowly. Syncing may be delayed.",
    bannerBg: "bg-amber-50",
    bannerBorder: "border-amber-200",
    titleColor: "text-amber-800",
    descColor: "text-amber-700",
    iconColor: "text-amber-600",
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
          "flex items-center gap-2 px-3 py-2 rounded-lg",
          config.bannerBg,
          config.bannerBorder,
          "border",
          config.titleColor,
          className
        )}
      >
        <Icon className="size-4 flex-shrink-0" />
        <span className="text-sm font-medium">{config.title}</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-start gap-3 p-3 rounded-lg",
        config.bannerBg,
        config.bannerBorder,
        "border",
        className
      )}
    >
      <div className="flex-shrink-0 mt-0.5">
        <Icon className={cn("size-5", config.iconColor)} />
      </div>
      <div className="flex-1">
        <p className={cn("text-sm font-medium", config.titleColor)}>
          {config.title}
        </p>
        <p className={cn("text-xs mt-1", config.descColor)}>
          {config.description}
        </p>
      </div>
    </div>
  );
};

export default SyncConnectivityAlert;
