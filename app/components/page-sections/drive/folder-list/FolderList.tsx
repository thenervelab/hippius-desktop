"use client";

import React, { useState } from "react";
import { Cloud, CloudOff } from "lucide-react";

import { Icons } from "@/components/ui";
import { Button } from "@/components/ui/button";
import TableActionMenu, { type ActionItem } from "@/components/ui/alt-table/TableActionMenu";
import { SettingsCard } from "@/components/page-sections/settings/SettingsCard";
import FolderCardContextMenu from "@/app/components/ui/context-menu/FolderCardContextMenu";
import FolderRowSkeleton from "@/components/page-sections/settings/multi-folder-sync/FolderRowSkeleton";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/utils/formatBytes";

import { isCloudOnly, presenceLabel, type FolderRow } from "./folderRows";

function formatRowDate(timestamp: number) {
  const d = new Date(timestamp);
  const month = d.toLocaleString("en-US", { month: "short" });
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "pm" : "am";
  hours = hours % 12 || 12;
  return `${month} ${d.getDate()}, ${d.getFullYear()} at ${hours}:${minutes} ${ampm}`;
}

const Dot = () => (
  <span
    aria-hidden="true"
    className="w-[3px] h-[3px] rounded-full bg-[#9D9D9D] dark:bg-[#5a5a5a] flex-shrink-0"
  />
);

/**
 * The cloud mark.
 *
 * With the three section headings gone, this is what tells a folder that
 * lives elsewhere from one taking disk on this machine — the distinction
 * the headings used to carry. `CloudOff` for a folder synced nowhere right
 * now, `Cloud` for one another device is syncing: both are "not here", but
 * only one of them is being kept up to date by something.
 */
const PresenceMark: React.FC<{ row: FolderRow }> = ({ row }) => {
  if (!isCloudOnly(row.presence)) return null;
  const Mark = row.presence === "not-synced-here" ? CloudOff : Cloud;
  return (
    <span
      className="inline-flex flex-shrink-0 items-center text-grey-60 dark:text-grey-dark-600"
      title={presenceLabel(row)}
      aria-label={presenceLabel(row)}
    >
      <Mark className="size-4" strokeWidth={1.75} />
    </span>
  );
};

const StatusPill: React.FC<{ row: FolderRow }> = ({ row }) => {
  if (row.presence !== "on-this-device" || !row.status) return null;
  const tone =
    row.status === "error"
      ? "border-error-50/40 text-error-50"
      : row.status === "paused"
        ? "border-grey-70/40 text-grey-60 dark:text-grey-dark-600"
        : "border-success-50/40 text-success-50";
  const label = row.status === "error" ? "Error" : row.status === "paused" ? "Paused" : "Syncing";
  return (
    <span
      className={cn(
        "inline-flex flex-shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        tone,
      )}
    >
      {row.status === "syncing" && (
        <span className="size-1.5 rounded-full bg-success-50" aria-hidden="true" />
      )}
      {label}
    </span>
  );
};

export interface FolderListProps {
  rows: FolderRow[];
  isLoading?: boolean;
  /** Card heading. */
  label?: string;
  /** Rendered to the right of the heading (e.g. the Sync a Folder button). */
  headerAction?: React.ReactNode;
  /** Opening a folder — a click anywhere on the row that is not the menu. */
  onOpenRow?: (row: FolderRow) => void;
  /** Menu contents, composed by the caller so the gating rules stay put. */
  buildActions?: (row: FolderRow) => ActionItem[];
  /** Shown when there are no folders at all. */
  emptyState?: React.ReactNode;
}

/**
 * Every folder on the account, in one list.
 *
 * Replaces the three stacked cards — Local Sync Folders, Sync from Other
 * Devices, Not synced on this computer — that split one idea across three
 * headings. What each heading said now rides on the row: a cloud mark and
 * a short label under the name.
 *
 * The action menu is composed by the caller rather than here, because what
 * a row can do depends on rules that already live elsewhere (member-drive
 * gating, selective sync, delete-from-server). Rebuilding them here would
 * be a second copy that drifts.
 */
const FolderList: React.FC<FolderListProps> = ({
  rows,
  isLoading = false,
  label = "Your Folders",
  headerAction,
  onOpenRow,
  buildActions,
  emptyState,
}) => {
  // Right-click opens the SAME menu as the three dots. The sectioned list
  // it replaced offered both, and they were built from one resolver so
  // they could not drift — keeping that here rather than giving the two
  // affordances separate item lists.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    row: FolderRow;
  } | null>(null);

  return (
    <SettingsCard
      label={label}
      icon={<Icons.Folder className="size-3.5" />}
      headerAction={headerAction}
    >
      {isLoading ? (
        <div className="flex flex-col">
          {[0, 1, 2].map((i) => (
            <FolderRowSkeleton key={i} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="px-3 py-6">{emptyState}</div>
      ) : (
        <div className="flex flex-col">
          {rows.map((row) => (
            <div
              key={`${row.presence}:${row.id}`}
              onClick={(e) => {
                // The menu lives inside the row; its clicks are not opens.
                if ((e.target as HTMLElement).closest(".action-menu-area")) return;
                onOpenRow?.(row);
              }}
              onContextMenu={(e) => {
                if (!buildActions) return;
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, row });
              }}
              className={cn(
                "flex items-start gap-2 border-t border-grey-dark-100 px-3 py-3 first:border-t-0 dark:border-black-300",
                onOpenRow && "cursor-pointer hover:bg-grey-90/40 dark:hover:bg-white/5",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Icons.Folder className="size-4 flex-shrink-0 text-[#1F50BD]" />
                  <span className="truncate font-geist text-[14px] font-medium text-[#0A0A0A] dark:text-white">
                    {row.folderName}
                  </span>
                  <PresenceMark row={row} />
                  <StatusPill row={row} />

                  {(Boolean(row.totalBytes) || Boolean(row.fileCount) || row.lastModified > 0) && (
                    <span className="h-4 w-px flex-shrink-0 bg-grey-80 dark:bg-[#3a3a3a]" />
                  )}
                  {Boolean(row.totalBytes) && (
                    <span className="flex items-center gap-1 whitespace-nowrap text-xs text-grey-60 dark:text-grey-dark-600">
                      <Icons.Database className="size-3.5 text-[#1F50BD]" />
                      {formatBytes(row.totalBytes ?? 0)}
                    </span>
                  )}
                  {Boolean(row.fileCount) && (
                    <>
                      {Boolean(row.totalBytes) && <Dot />}
                      <span className="flex items-center gap-1 whitespace-nowrap text-xs text-grey-60 dark:text-grey-dark-600">
                        <Icons.Folders className="size-3.5 text-[#1F50BD]" />
                        {row.fileCount} {row.fileCount === 1 ? "file" : "files"}
                      </span>
                    </>
                  )}
                  {row.lastModified > 0 && (
                    <>
                      {(Boolean(row.totalBytes) || Boolean(row.fileCount)) && <Dot />}
                      <span className="flex items-center gap-1 whitespace-nowrap text-xs text-grey-60 dark:text-grey-dark-600">
                        <Icons.Clock8 className="size-3.5 text-[#1F50BD]" />
                        {formatRowDate(row.lastModified)}
                      </span>
                    </>
                  )}
                </div>

                {/* Replaces the section heading this row used to sit under. */}
                <p className="ml-6 mt-1 font-geist text-[13px] font-medium text-[#0A0A0A]/40 dark:text-white/40">
                  {row.presence === "on-this-device"
                    ? (row.local?.localPath ?? presenceLabel(row))
                    : presenceLabel(row)}
                </p>

                {row.status === "error" && row.local?.errorMessage && (
                  <p className="ml-6 mt-1 text-xs font-medium text-error-50">
                    {row.local.errorMessage}
                  </p>
                )}
              </div>

              {buildActions && (
                <TableActionMenu dropdownTitle="" items={buildActions(row)}>
                  <Button
                    variant="ghost"
                    size="auto"
                    className="action-menu-area mt-0.5 h-8 w-8 flex-shrink-0 rounded-md p-0 text-grey-70 transition-colors hover:bg-grey-90 hover:text-grey-30 dark:text-grey-dark-600 dark:hover:bg-white/10 dark:hover:text-white"
                  >
                    <Icons.EllipsisVertical className="size-[18px]" />
                  </Button>
                </TableActionMenu>
              )}
            </div>
          ))}
        </div>
      )}
      {contextMenu && buildActions && (
        <FolderCardContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={buildActions(contextMenu.row).map((item) => ({
            icon: item.icon,
            label: String(item.itemTitle),
            onClick: () => item.onItemClick?.(),
            ...(item.variant ? { variant: item.variant } : {}),
            ...(item.disabled ? { disabled: true } : {}),
            ...(item.tooltip ? { tooltip: item.tooltip } : {}),
          }))}
        />
      )}
    </SettingsCard>
  );
};

export default FolderList;
