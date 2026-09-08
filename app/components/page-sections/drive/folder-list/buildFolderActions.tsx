"use client";

import React from "react";
import {
  PauseCircle,
  PlayCircle,
  FolderMinus,
  CloudDownload,
  FolderSearch,
} from "lucide-react";

import { Icons } from "@/components/ui";
import type { ActionItem } from "@/components/ui/alt-table/TableActionMenu";
import { resolveFolderMenuPlan } from "@/components/page-sections/settings/multi-folder-sync/folderMenuGating";
import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import type { RemoteFolder, SyncFolder } from "@/app/lib/types/sync-folder";

import type { FolderRow } from "./folderRows";

export interface FolderActionHandlers {
  onOpen?: (row: FolderRow) => void;
  onPause?: (folder: SyncFolder) => void;
  onResume?: (folder: SyncFolder) => void;
  onManageExclusions?: (folder: SyncFolder) => void;
  /** `mode` is "leave" for a member drive — see `folderMenuGating`. */
  onRemove?: (folder: SyncFolder, mode: "remove" | "leave") => void;
  onDeleteFromServer?: (folderName: string, folderId?: string) => void;
  onSyncRemote?: (folder: RemoteFolder) => void;
  onBrowseRemote?: (folder: RemoteFolder) => void;
}

/**
 * The row menu, built once for every surface that shows the folder list.
 *
 * Lives outside `FolderList` because what a row may do depends on rules
 * that already have a home — above all `folderMenuGating`, where member
 * drives are protected. It lives outside the two call sites because the
 * Drive page and Settings show the same list, and a menu built twice is a
 * menu that drifts: that is how one surface ends up offering a member row
 * "Delete from Server", which the backend would key by the wrong identity.
 */
export function buildFolderActions(
  row: FolderRow,
  handlers: FolderActionHandlers,
): ActionItem[] {
  if (row.local) {
    const folder = row.local;
    const plan = resolveFolderMenuPlan(folder, {
      sharedDrivesEnabled: SHARED_DRIVES_ENABLED,
    });
    const items: ActionItem[] = [];

    if (handlers.onOpen) {
      items.push({
        icon: <Icons.FolderOpen className="size-4" />,
        itemTitle: "Open",
        onItemClick: () => handlers.onOpen?.(row),
      });
    }
    if (handlers.onPause || handlers.onResume) {
      const paused = folder.status === "paused";
      items.push({
        icon: paused ? <PlayCircle className="size-4" /> : <PauseCircle className="size-4" />,
        itemTitle: paused ? "Resume Sync" : "Pause Sync",
        onItemClick: () =>
          paused ? handlers.onResume?.(folder) : handlers.onPause?.(folder),
      });
    }
    if (plan.showExclusions && handlers.onManageExclusions) {
      items.push({
        icon: <FolderMinus className="size-4" />,
        itemTitle: "Excluded from Sync",
        onItemClick: () => handlers.onManageExclusions?.(folder),
      });
    }
    if (plan.showDeleteFromServer && handlers.onDeleteFromServer) {
      items.push({
        icon: <Icons.Trash className="size-4" />,
        itemTitle: "Delete from Server",
        variant: "destructive",
        onItemClick: () => handlers.onDeleteFromServer?.(folder.folderName, folder.id),
      });
    }
    if (handlers.onRemove) {
      items.push({
        icon: <Icons.CloseCircle className="size-4" />,
        itemTitle: plan.removeItemTitle,
        variant: "destructive",
        onItemClick: () =>
          handlers.onRemove?.(folder, plan.removeIsLeave ? "leave" : "remove"),
      });
    }
    return items;
  }

  const folder = row.remote;
  if (!folder) return [];
  const items: ActionItem[] = [];
  if (handlers.onOpen) {
    items.push({
      icon: <Icons.FolderOpen className="size-4" />,
      itemTitle: "Open",
      onItemClick: () => handlers.onOpen?.(row),
    });
  }
  if (handlers.onSyncRemote) {
    items.push({
      icon: <CloudDownload className="size-4" />,
      itemTitle: "Sync to this computer",
      onItemClick: () => handlers.onSyncRemote?.(folder),
    });
  }
  if (handlers.onBrowseRemote) {
    items.push({
      icon: <FolderSearch className="size-4" />,
      itemTitle: "Browse Contents",
      onItemClick: () => handlers.onBrowseRemote?.(folder),
    });
  }
  if (handlers.onDeleteFromServer) {
    items.push({
      icon: <Icons.Trash className="size-4" />,
      itemTitle: "Delete from Server",
      variant: "destructive",
      onItemClick: () => handlers.onDeleteFromServer?.(folder.folderName),
    });
  }
  return items;
}
