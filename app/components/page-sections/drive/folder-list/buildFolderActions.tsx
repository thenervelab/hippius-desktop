"use client";

import React from "react";
import {
  PauseCircle,
  PlayCircle,
  FolderMinus,
  CloudDownload,
  FolderSearch,
  FolderOpen,
  UserPlus,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { fileManagerLabel } from "@/lib/utils/isMacPlatform";
import { tauriErrorMessage } from "@/lib/utils/dispatchTauriError";

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
  /** Selective-sync picker for a LOCAL drive. */
  /** Only offered while `SHARED_DRIVES_ENABLED`, and never on a member row. */
  onShareDrive?: (folder: SyncFolder) => void;
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
        itemTitle: paused ? "Resume syncing" : "Pause syncing",
        onItemClick: () =>
          paused ? handlers.onResume?.(folder) : handlers.onPause?.(folder),
      });
    }
    // Reveal on disk. Only a local row has a path to reveal, which is why
    // it lives in this branch rather than beside the shared items.
    items.push({
      icon: <FolderOpen className="size-4" />,
      itemTitle: `Open in ${fileManagerLabel()}`,
      onItemClick: () => {
        void invoke("reveal_path_in_file_manager", { path: folder.localPath }).catch(
          (error: unknown) => {
            console.error("Failed to open in file manager:", error);
            toast.error(tauriErrorMessage(error));
          },
        );
      },
    });
    if (plan.showShareDrive && handlers.onShareDrive) {
      items.push({
        icon: <UserPlus className="size-4" />,
        itemTitle: "Share drive…",
        onItemClick: () => handlers.onShareDrive?.(folder),
      });
    }
    if (plan.showExclusions && handlers.onManageExclusions) {
      items.push({
        icon: <FolderMinus className="size-4" />,
        itemTitle: "Sync exclusions…",
        onItemClick: () => handlers.onManageExclusions?.(folder),
      });
    }
    if (handlers.onRemove) {
      items.push({
        icon: <Icons.CloseCircle className="size-4" />,
        itemTitle: plan.removeItemTitle,
        onItemClick: () =>
          handlers.onRemove?.(folder, plan.removeIsLeave ? "leave" : "remove"),
      });
    }
    if (plan.showDeleteFromServer && handlers.onDeleteFromServer) {
      items.push({
        icon: <Icons.Trash className="size-4" />,
        itemTitle: "Delete from Hippius",
        variant: "destructive",
        onItemClick: () => handlers.onDeleteFromServer?.(folder.folderName, folder.id),
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
      itemTitle: "Choose what syncs…",
      onItemClick: () => handlers.onBrowseRemote?.(folder),
    });
  }
  if (handlers.onDeleteFromServer) {
    items.push({
      icon: <Icons.Trash className="size-4" />,
      itemTitle: "Delete from Hippius",
      variant: "destructive",
      onItemClick: () => handlers.onDeleteFromServer?.(folder.folderName),
    });
  }
  return items;
}
