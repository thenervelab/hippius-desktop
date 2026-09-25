// The overflow menu on a "Shared with me" row.
//
// A pure builder, the `buildFolderActions` convention: what a row offers
// depends on rules (is it synced here, may this account manage it) that are
// worth testing without rendering a menu.

import React from "react";
import { FolderOpen, LogOut, RefreshCw } from "lucide-react";

import type { ActionItem } from "@/components/ui/alt-table/TableActionMenu";
import type { DriveMembershipInfo } from "@/app/lib/tauri/sharedDrives";
import type { DriveRole } from "@/app/lib/shared-drives/roles";

export interface SharedDriveActionHandlers {
  membership: DriveMembershipInfo;
  role: DriveRole;
  /** Whether a local copy of this drive already exists on this device. */
  isSynced: boolean;
  /** A sync is already in flight somewhere in the list. */
  busy: boolean;
  /** Browse it without a local copy. Absent where there is nowhere to browse to. */
  onOpen?: () => void;
  onSyncLocally: () => void;
  onLeave: () => void;
}

/**
 * What a shared-drive row offers.
 *
 * Open comes first: looking at what somebody shared is the common intent, and
 * it needs no local copy. Syncing is the one that changes this machine, and
 * leaving is destructive, so it sits last and reads as such.
 */
export function buildSharedDriveActions(
  handlers: SharedDriveActionHandlers,
): ActionItem[] {
  const items: ActionItem[] = [];

  if (handlers.onOpen) {
    items.push({
      icon: <FolderOpen className="size-4" />,
      itemTitle: "Open",
      onItemClick: handlers.onOpen,
    });
  }

  // Only offered while there is no local copy. A second "sync" on a drive
  // already synced here would either no-op or re-install it at a new path,
  // and neither is what the word promises.
  if (!handlers.isSynced) {
    items.push({
      icon: <RefreshCw className="size-4" />,
      itemTitle: "Sync to this computer",
      disabled: handlers.busy,
      onItemClick: handlers.onSyncLocally,
    });
  }

  items.push({
    icon: <LogOut className="size-4" />,
    itemTitle: "Leave drive",
    variant: "destructive",
    onItemClick: handlers.onLeave,
  });

  return items;
}

/**
 * What a shared FOLDER row offers: open it (rooted at the folder) and leave.
 * No "Sync to this computer": syncing a granted folder to disk is not
 * supported yet, and offering it would promise what the app cannot do.
 */
export function buildFolderGrantActions(handlers: {
  onOpen?: () => void;
  onLeave: () => void;
}): ActionItem[] {
  const items: ActionItem[] = [];
  if (handlers.onOpen) {
    items.push({
      icon: <FolderOpen className="size-4" />,
      itemTitle: "Open",
      onItemClick: handlers.onOpen,
    });
  }
  items.push({
    icon: <LogOut className="size-4" />,
    itemTitle: "Leave folder",
    variant: "destructive",
    onItemClick: handlers.onLeave,
  });
  return items;
}
