import type { CapacitySource } from "@/app/lib/hooks/api/useStorageOverview";
import { NO_PLAN_RETENTION_DAYS } from "@/app/components/page-sections/drive/service-status/driveStatusBannerState";

import type { UploadBlockReason } from "./uploadRoomState";

export type UploadBlockDialogCopy = {
  title: string;
  description: string;
  primaryLabel: string;
};

/**
 * Dialog body for a blocked upload / sync / drop.
 *
 * Must match the Overview and Drive banners so one account is not told two
 * stories. No-plan carries the 30-day deletion clock; over-quota does not.
 * No em dashes in these strings (product copy rule).
 */
export function getUploadBlockDialogCopy(
  reason: UploadBlockReason,
  capacitySource?: CapacitySource,
): UploadBlockDialogCopy {
  if (reason === "no-plan") {
    return {
      title: "You don't have a subscription plan",
      description: `Your account has no storage. Files you have already uploaded are permanently deleted after ${NO_PLAN_RETENTION_DAYS} days without a plan, and nothing new can be uploaded until you subscribe.`,
      primaryLabel: "Subscribe",
    };
  }

  if (capacitySource === "free") {
    return {
      title: "You're over your free storage",
      description:
        "Uploads are paused, your files stay available. Upgrade or free up space.",
      primaryLabel: "Upgrade",
    };
  }

  return {
    title: "You're over your plan's storage",
    description:
      "Uploads are paused, your files stay available. Upgrade to a larger plan or free up space.",
    primaryLabel: "Upgrade",
  };
}

/**
 * How a blocked surface should behave.
 *
 * Toolbar buttons and context-menu items are disabled (not clickable).
 * Drag-and-drop still opens the subscribe/upgrade dialog so the user gets
 * an explanation without starting an upload.
 */
export type BlockedUploadSurface = "button" | "context-menu" | "drag-drop";

export function blockedUploadInteraction(
  surface: BlockedUploadSurface,
): "disable" | "show-dialog" {
  if (surface === "drag-drop") return "show-dialog";
  return "disable";
}
