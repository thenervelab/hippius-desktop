"use client";

import React, { useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { InView } from "react-intersection-observer";
import { useSetAtom } from "jotai";
import { Icons } from "@/components/ui";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/utils/formatBytes";
import { middleTruncate, middleTruncatePath } from "@/lib/utils/middleTruncate";
import {
  Filter as FilterIcon,
  Folder,
  FolderOpen,
  FolderSearch,
  LogOut,
  Trash2,
  PauseCircle,
  PlayCircle,
  ServerCrash,
  UserPlus,
} from "lucide-react";
import TableActionMenu, { ActionItem } from "@/components/ui/alt-table/TableActionMenu";
import { Button } from "@/components/ui/button";
import { SettingsCard } from "../SettingsCard";
import FolderRowSkeleton from "./FolderRowSkeleton";
import * as Tooltip from "@radix-ui/react-tooltip";
import type { SyncFolder } from "@/app/lib/types/sync-folder";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { tauriErrorMessage } from "@/lib/utils/dispatchTauriError";
import { fileManagerLabel } from "@/lib/utils/isMacPlatform";
import FolderCardContextMenu from "@/app/components/ui/context-menu/FolderCardContextMenu";
import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import { shareDriveModalAtom } from "@/app/lib/global-atoms/sharesAtoms";
import {
  LEAVE_UNAVAILABLE_TOOLTIP,
  resolveFolderMenuPlan,
} from "./folderMenuGating";

const OwnerAvatar = dynamic(() => import("boring-avatars"), { ssr: false });

interface LocalFoldersSectionProps {
  syncFolders: SyncFolder[];
  isLoading: boolean;
  onAddFolder: () => void;
  onPauseFolder: (folder: SyncFolder) => void;
  onResumeFolder: (folder: SyncFolder) => void;
  onManageExclusions: (folder: SyncFolder) => void;
  onRemoveFolder: (folder: SyncFolder) => void;
  onDeleteFromServer: (folderName: string, folderId: string) => void;
  onBrowseFolder: (folder: SyncFolder) => void;
  // When provided, the folder row becomes clickable — used by the drive
  // "Local" view (see SyncFolderBreadcrumb) to switch the active folder.
  // The action menu and its children continue to handle their own clicks.
  onSelectFolder?: (folder: SyncFolder) => void;
  // Member-drive rows route their remove item ("Leave shared drive")
  // here instead of onRemoveFolder — leaving ends the account's server
  // membership, not just this device's sync, and the parent owns the
  // leave IPC and its feature-off fallback. Falls back to onRemoveFolder
  // when absent (a surface not yet wired for shared drives).
  onLeaveDrive?: (folder: SyncFolder) => void;
}

/**
 * One row action shared by both menus (the 3-dot `TableActionMenu` and the
 * right-click `FolderCardContextMenu`). Built once per folder by
 * `buildFolderActions` so the two menus cannot drift — historically each
 * duplicated its own item list.
 */
interface FolderAction {
  icon: React.ReactNode;
  title: string;
  variant?: "destructive";
  onClick: () => void;
  /** Rendered non-interactive (dimmed, `tooltip` states why) in both menus. */
  disabled?: boolean;
  tooltip?: string;
}

/**
 * Small "shared by" pill on member-drive rows: the drive owner's identicon
 * plus a truncated ss58. Flag-gated with the rest of the shared-drive
 * surfaces; `ownerSs58` is threaded from Rust and is the row's only
 * member/own discriminant.
 */
function OwnerBadge({ ownerSs58 }: { ownerSs58: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-[3px] rounded-full bg-primary-50/10 flex-shrink-0"
      title={`Shared by ${ownerSs58}`}
    >
      <span className="size-3 overflow-hidden rounded-full flex-shrink-0">
        <OwnerAvatar name={ownerSs58} size={12} variant="pixel" />
      </span>
      <span className="font-mono text-[10px] font-semibold leading-none text-primary-50">
        {middleTruncate(ownerSs58, 12)}
      </span>
    </span>
  );
}

/**
 * Status badge matching the On/Off pill in NotificationSection:
 *   - Syncing → "On" treatment (green pill, green concentric-circle dot)
 *   - Paused  → "Off" treatment (neutral grey pill / muted dot)
 *   - Error   → red variant of the same shape
 */
function StatusBadge({ status }: { status: SyncFolder["status"] }) {
  const styles: Record<
    SyncFolder["status"],
    { wrap: string; tone: string; label: string }
  > = {
    syncing: {
      wrap: "bg-[rgba(4,200,112,0.2)]",
      tone: "text-[#04c870]",
      label: "Syncing",
    },
    paused: {
      wrap: "bg-[#f0f0f0] dark:bg-white/10",
      tone: "text-[#b6b6b6] dark:text-grey-dark-500",
      label: "Paused",
    },
    error: {
      wrap: "bg-error-50/20",
      tone: "text-error-50",
      label: "Error",
    },
  };
  const s = styles[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[5px] px-[8.8px] py-[5px] rounded-full flex-shrink-0",
        s.wrap
      )}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 9.5 9.5"
        fill="none"
        className={cn("flex-shrink-0", s.tone)}
      >
        <circle cx="4.75" cy="4.75" r="4.75" fill="currentColor" fillOpacity="0.2" />
        <circle cx="4.75" cy="4.75" r="2.375" fill="currentColor" />
      </svg>
      <span
        className={cn(
          "text-[10px] font-semibold leading-none tracking-[-0.2px]",
          s.tone
        )}
      >
        {s.label}
      </span>
    </span>
  );
}

function formatRowDate(timestamp: number) {
  const d = new Date(timestamp);
  const month = d.toLocaleString("en-US", { month: "short" });
  const day = d.getDate();
  const year = d.getFullYear();
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "pm" : "am";
  hours = hours % 12 || 12;
  return `${month} ${day}, ${year} at ${hours}:${minutes} ${ampm}`;
}

function PathTooltip({ path }: { path: string }) {
  const display = middleTruncatePath(path, 40);
  const truncated = display !== path;

  const text = (
    <p className="font-geist text-[14px] font-medium leading-normal text-[#0A0A0A]/40 dark:text-white/40 mt-2 ml-6 cursor-default">
      {display}
    </p>
  );

  if (!truncated) return text;

  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{text}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="bottom"
            align="start"
            sideOffset={2}
            className="z-[9999] max-w-[28rem] bg-white border border-grey-80 rounded-lg px-3 py-2 text-xs font-medium text-grey-40 shadow-lg break-all animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          >
            {path}
            <Tooltip.Arrow className="fill-white" width={12} height={6} />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

export function LocalFoldersSection({
  syncFolders,
  isLoading,
  onAddFolder,
  onPauseFolder,
  onResumeFolder,
  onManageExclusions,
  onRemoveFolder,
  onDeleteFromServer,
  onBrowseFolder,
  onSelectFolder,
  onLeaveDrive,
}: LocalFoldersSectionProps) {
  const [cardContextMenu, setCardContextMenu] = useState<{
    x: number;
    y: number;
    folder: SyncFolder;
  } | null>(null);
  const setShareDriveTarget = useSetAtom(shareDriveModalAtom);



  // One action list per folder feeds BOTH menus (3-dot + right-click), with
  // the own-vs-member gating resolved by the pure `resolveFolderMenuPlan`.
  const buildFolderActions = useCallback(
    (folder: SyncFolder): FolderAction[] => {
      const plan = resolveFolderMenuPlan(folder, {
        sharedDrivesEnabled: SHARED_DRIVES_ENABLED,
      });

      const actions: FolderAction[] = [
        {
          icon: <FolderSearch className="size-4" />,
          title: "Browse Contents",
          onClick: () => onBrowseFolder(folder),
        },
        {
          icon:
            folder.status === "syncing" ? (
              <PauseCircle className="size-4" />
            ) : (
              <PlayCircle className="size-4" />
            ),
          title: folder.status === "syncing" ? "Pause Sync" : "Resume Sync",
          onClick: () =>
            folder.status === "syncing"
              ? onPauseFolder(folder)
              : onResumeFolder(folder),
        },
        {
          icon: <FolderOpen className="size-4" />,
          title: `Open in ${fileManagerLabel()}`,
          onClick: async () => {
            try {
              await invoke("reveal_path_in_file_manager", {
                path: folder.localPath,
              });
            } catch (error) {
              console.error("Failed to open in file manager:", error);
              toast.error(tauriErrorMessage(error));
            }
          },
        },
      ];

      if (plan.showShareDrive) {
        actions.push({
          icon: <UserPlus className="size-4" />,
          title: "Share drive…",
          onClick: () =>
            setShareDriveTarget({
              label: folder.id,
              folderName: folder.folderName,
            }),
        });
      }
      if (plan.showExclusions) {
        actions.push({
          icon: <FilterIcon className="size-4" />,
          title: "Excluded from Sync",
          onClick: () => onManageExclusions(folder),
        });
      }
      if (plan.removeIsLeave) {
        // A member row's remove item NEVER falls back to onRemoveFolder:
        // plain remove tears down only this device's sync and strands the
        // live server-side membership. On a surface that hasn't wired
        // onLeaveDrive the item renders disabled with the reason instead
        // (both parent surfaces wire it today, so this is defensive).
        actions.push({
          icon: <LogOut className="size-4" />,
          title: plan.removeItemTitle,
          ...(onLeaveDrive
            ? { onClick: () => onLeaveDrive(folder) }
            : {
                onClick: () => {},
                disabled: true,
                tooltip: LEAVE_UNAVAILABLE_TOOLTIP,
              }),
        });
      } else {
        actions.push({
          icon: <Trash2 className="size-4" />,
          title: plan.removeItemTitle,
          onClick: () => onRemoveFolder(folder),
        });
      }
      if (plan.showDeleteFromServer) {
        actions.push({
          icon: <ServerCrash className="size-4" />,
          title: "Delete from Server",
          variant: "destructive" as const,
          onClick: () => onDeleteFromServer(folder.folderName, folder.id),
        });
      }
      return actions;
    },
    [
      onBrowseFolder,
      onPauseFolder,
      onResumeFolder,
      onManageExclusions,
      onRemoveFolder,
      onDeleteFromServer,
      onLeaveDrive,
      setShareDriveTarget,
    ],
  );

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <>
          <div
            ref={ref}
            className={cn(
              "transition-all duration-500 ease-out",
              inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
            )}
          >
            <SettingsCard
              label="Local Sync Folders"
              icon={<Folder className="size-4" />}
        headerAction={
          <Button
            variant="defaultStable"
            size="auto"
            onClick={onAddFolder}
            className={cn(
              "h-[30px] gap-[7px] rounded-[6px] border px-3 text-[14px] font-normal leading-[1.109] tracking-[-0.28px]",
              "border-grey-dark-100 bg-[#FEFEFE] text-[#111]",
              "shadow-[0_5px_2.3px_rgba(0,0,0,0.03),0_1px_1.9px_rgba(0,0,0,0.14),0_0_1px_rgba(0,0,0,0.16),inset_0_1px_0_#FFF]",
              "hover:bg-[#F5F5F5]",
              "dark:border-black-300 dark:bg-black-600 dark:text-grey-dark-300 dark:shadow-[0_1px_2px_rgba(0,0,0,0.4)] dark:hover:bg-black-500"
            )}
          >
            + Add Folder
          </Button>
        }
      >
        {/* Content */}
        {isLoading ? (
          <div>
            <FolderRowSkeleton hasStatusBadge />
            <FolderRowSkeleton hasStatusBadge />
            <FolderRowSkeleton />
          </div>
        ) : syncFolders.length === 0 ? (
          <div className="flex min-h-[139px] flex-col items-center justify-center gap-[5px] px-4 py-6 text-center">
            <p className="font-geist text-[14px] font-medium leading-[20px] tracking-[-0.28px] text-black dark:text-white">
              No Folder Syncing Yet
            </p>
            <p className="font-geist w-[262px] max-w-full text-[14px] font-medium leading-[17px] tracking-[-0.28px] text-[#7D7D7D] dark:text-grey-dark-600">
              Add a folder to get started with encrypted sync
            </p>
          </div>
        ) : (
          <div className="max-h-[420px] overflow-y-auto">
            {syncFolders.map((folder) => (
              <div
                key={folder.id}
                role={onSelectFolder ? "button" : undefined}
                tabIndex={onSelectFolder ? 0 : undefined}
                className={cn(
                  "flex items-start justify-between p-3 transition-colors",
                  // When the row is clickable (drive's Local cards view),
                  // use a more pronounced hover treatment + pointer
                  // cursor so it reads as "navigate into this folder".
                  // `[&_*]:cursor-pointer` propagates the pointer to the
                  // tooltip-wrapped name/path spans that otherwise carry
                  // `cursor-default` and locally win the cascade.
                  // Settings reuses this same component with no
                  // onSelectFolder and keeps the subtler hover.
                  onSelectFolder
                    ? "cursor-pointer [&_*]:cursor-pointer hover:bg-grey-light-400 dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-50"
                    : "hover:bg-grey-light-400 dark:hover:bg-white/5",
                )}
                onClick={(e) => {
                  if (!onSelectFolder) return;
                  // Ignore clicks that originated inside the action menu / its
                  // popover so menu interactions don't double as selections.
                  const target = e.target as HTMLElement;
                  if (target.closest(".action-menu-area")) return;
                  if (target.closest("[role='menu']")) return;
                  onSelectFolder(folder);
                }}
                onKeyDown={(e) => {
                  if (!onSelectFolder) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelectFolder(folder);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCardContextMenu({ x: e.clientX, y: e.clientY, folder });
                }}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-[7px] flex-wrap">
                    <Folder className="size-4 text-primary-50 flex-shrink-0" />
                    <Tooltip.Provider delayDuration={200}>
                      <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                          <span className="text-sm font-medium text-grey-10 dark:text-white cursor-default">
                            {middleTruncate(folder.folderName, 30)}
                          </span>
                        </Tooltip.Trigger>
                        {middleTruncate(folder.folderName, 30) !== folder.folderName && (
                          <Tooltip.Portal>
                            <Tooltip.Content
                              side="bottom"
                              sideOffset={4}
                              className="z-[9999] max-w-[25rem] bg-white border border-grey-80 rounded-lg px-3 py-2 text-xs font-medium text-grey-40 shadow-lg break-all animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
                            >
                              {folder.folderName}
                              <Tooltip.Arrow className="fill-white" width={12} height={6} />
                            </Tooltip.Content>
                          </Tooltip.Portal>
                        )}
                      </Tooltip.Root>
                    </Tooltip.Provider>

                    <StatusBadge status={folder.status} />

                    {SHARED_DRIVES_ENABLED && folder.ownerSs58 && (
                      <OwnerBadge ownerSs58={folder.ownerSs58} />
                    )}

                    {(folder.totalBytes || folder.fileCount || folder.lastModified) ? (
                      <span className="h-4 w-px bg-grey-80 dark:bg-[#3a3a3a] flex-shrink-0" />
                    ) : null}

                    {folder.totalBytes !== undefined && folder.totalBytes > 0 && (
                      <span className="flex items-center gap-1 text-xs text-grey-60 dark:text-grey-dark-600 whitespace-nowrap">
                        <Icons.Database className="size-3.5 text-[#1F50BD]" />
                        {formatBytes(folder.totalBytes)}
                      </span>
                    )}
                    {folder.fileCount !== undefined && folder.fileCount > 0 && (
                      <>
                        {folder.totalBytes !== undefined && folder.totalBytes > 0 && (
                          <span aria-hidden="true" className="w-[3px] h-[3px] rounded-full bg-[#9D9D9D] dark:bg-[#5a5a5a] flex-shrink-0" />
                        )}
                        <span className="flex items-center gap-1 text-xs text-grey-60 dark:text-grey-dark-600 whitespace-nowrap">
                          <Icons.Folders className="size-3.5 text-[#1F50BD]" />
                          {folder.fileCount}{" "}
                          {folder.fileCount === 1 ? "file" : "files"}
                        </span>
                      </>
                    )}
                    {folder.lastModified !== undefined && folder.lastModified > 0 && (
                      <>
                        {((folder.totalBytes !== undefined && folder.totalBytes > 0) ||
                          (folder.fileCount !== undefined && folder.fileCount > 0)) && (
                          <span aria-hidden="true" className="w-[3px] h-[3px] rounded-full bg-[#9D9D9D] dark:bg-[#5a5a5a] flex-shrink-0" />
                        )}
                        <span className="flex items-center gap-1 text-xs text-grey-60 dark:text-grey-dark-600 whitespace-nowrap">
                          <Icons.Clock8 className="size-3.5 text-[#1F50BD]" />
                          {formatRowDate(folder.lastModified)}
                        </span>
                      </>
                    )}
                  </div>
                  <PathTooltip path={folder.localPath} />
                  {folder.status === "error" && (
                    <div className="mt-2 ml-6 flex items-center gap-2">
                      {/* DriveStatus.Error message from Rust (init failure,
                          revoked shared drive). The Remove button routes to
                          the EXISTING remove-drive flow (same confirm dialog
                          as the menu's "Remove from Sync"), which is the
                          escape hatch for a revoked drive — remove_drive
                          fully cleans the row, member identity included. */}
                      <span className="text-xs font-medium text-error-50">
                        {folder.errorMessage ?? "Sync error"}
                      </span>
                      <Button
                        variant="ghost"
                        size="auto"
                        onClick={(e) => {
                          // Don't let the row's onSelectFolder click fire too.
                          e.stopPropagation();
                          onRemoveFolder(folder);
                        }}
                        className="h-6 flex-shrink-0 rounded-md border border-error-50/40 px-2 text-xs font-medium text-error-50 hover:bg-error-50/10"
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                </div>

                <TableActionMenu
                  dropdownTitle=""
                  items={
                    buildFolderActions(folder).map((action) => ({
                      icon: action.icon,
                      itemTitle: action.title,
                      ...(action.variant ? { variant: action.variant } : {}),
                      ...(action.disabled ? { disabled: true } : {}),
                      ...(action.tooltip ? { tooltip: action.tooltip } : {}),
                      onItemClick: action.onClick,
                    })) satisfies ActionItem[]
                  }
                >
                  <Button
                    variant="ghost"
                    size="auto"
                    className="h-8 w-8 p-0 action-menu-area mt-0.5 flex-shrink-0 rounded-md text-grey-70 hover:text-grey-30 hover:bg-grey-90 dark:text-grey-dark-600 dark:hover:text-white dark:hover:bg-white/10 transition-colors"
                  >
                    <Icons.EllipsisVertical className="size-[18px]" />
                  </Button>
                </TableActionMenu>
              </div>
            ))}
          </div>
        )}

            </SettingsCard>
          </div>

      {cardContextMenu && (
        <FolderCardContextMenu
          x={cardContextMenu.x}
          y={cardContextMenu.y}
          onClose={() => setCardContextMenu(null)}
          items={buildFolderActions(cardContextMenu.folder).map((action) => ({
            icon: action.icon,
            label: action.title,
            ...(action.variant ? { variant: action.variant } : {}),
            ...(action.disabled ? { disabled: true } : {}),
            ...(action.tooltip ? { tooltip: action.tooltip } : {}),
            onClick: action.onClick,
          }))}
        />
      )}
        </>
      )}
    </InView>
  );
}
