"use client";

import React, { useState } from "react";
import { Cloud, CloudOff, Users } from "lucide-react";

import { Icons } from "@/components/ui";
import { Button } from "@/components/ui/button";
import TableActionMenu, { type ActionItem } from "@/components/ui/alt-table/TableActionMenu";
// The files list's pager, NOT `alt-table`'s. That one styles its page
// buttons with `bg-grey-90` and no `dark:` variant, so on a dark drive list
// they rendered as near-white pills. This one is written for both themes,
// and `pageSize`/`setPageSize` are optional, so it drops in unchanged.
import { Pagination } from "@/components/ui/table";
import {
  FOLDER_LIST_PAGE_SIZE,
  resolveFolderListPage,
} from "./folderListPaging";
import { SettingsCard } from "@/components/page-sections/settings/SettingsCard";
import { driveRowSharing } from "@/app/lib/shared-drives/driveRowSharing";
import DriveRoleChip from "../DriveRoleChip";
import {
  isDriveShared,
  type DriveSharing,
} from "@/app/lib/hooks/useOwnedDriveSharing";
import type { DriveRole } from "@/app/lib/shared-drives/roles";
import FolderCardContextMenu from "@/app/components/ui/context-menu/FolderCardContextMenu";
import FolderRowSkeleton from "@/components/page-sections/settings/multi-folder-sync/FolderRowSkeleton";
import HostedRootNote from "@/components/page-sections/settings/multi-folder-sync/HostedRootNote";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/utils/formatBytes";
import { formatRowDate } from "./formatRowDate";
import { RowDot as Dot } from "./RowDot";

import { isCloudOnly, presenceLabel, type FolderRow } from "./folderRows";

/**
 * The cloud mark.
 *
 * With the three section headings gone, this is what tells a folder that
 * lives elsewhere from one taking disk on this machine — the distinction
 * the headings used to carry. `CloudOff` for a folder synced nowhere right
 * now, `Cloud` for one another device is syncing: both are "not here", but
 * only one of them is being kept up to date by something.
 */
/**
 * The shared mark.
 *
 * A drive that belongs to another account rendered identically to an owned
 * one — same icon, same name — so there was nothing to say whose it was or
 * what the viewer could do in it. The row already carried `ownerSs58`; this
 * is what reads it.
 *
 * The role rides alongside when it is known. When it is not, the badge still
 * says "Shared": that a drive belongs to someone else is a fact the row has
 * on its own, and withholding it until a second request lands would make the
 * list flicker between two meanings.
 */
const SharedMark: React.FC<{
  row: FolderRow;
  role?: DriveRole;
  sharing?: DriveSharing;
}> = ({ row, role, sharing: driveSharing }) => {
  const sharing = driveRowSharing({
    ownerSs58: row.ownerSs58,
    role,
    memberCount: driveSharing?.memberCount,
    liveInviteCount: driveSharing?.liveInviteCount,
    totalInviteCount: driveSharing?.totalInviteCount,
  });
  if (!sharing.isShared) return null;

  // A drive somebody shared with US is described by the ROLE, in the console's
  // colour-coded chip: that is the useful fact, and the chip says it in one
  // word. The generic "Shared" badge below stays for the case the role has
  // not arrived yet, where claiming a role would be guessing, and for a drive
  // WE shared, which has no role to show.
  if (sharing.direction === "with-me" && role) {
    return <DriveRoleChip role={role} />;
  }

  // Two opposite facts, so two readings. A drive shared WITH you is someone
  // else's and the useful thing is what you may do in it, so it takes the
  // blue "belongs elsewhere" treatment. One you shared is still yours, so it
  // takes a quieter neutral chip that says how far it has travelled rather
  // than claiming the row is foreign.
  const withMe = sharing.direction === "with-me";

  return (
    <span
      title={sharing.title ?? undefined}
      className={cn(
        // Same shape as StatusPill so the row reads as one row of facts
        // rather than a pill plus a smaller afterthought.
        "inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium",
        withMe
          ? "border-[#1F50BD]/50 bg-[#1F50BD]/10 text-[#1F50BD] dark:border-[#6b93ea]/50 dark:bg-[#6b93ea]/10 dark:text-[#9dbaf2]"
          : "border-[#1F50BD]/40 text-[#1F50BD] dark:border-[#6b93ea]/40 dark:text-[#9dbaf2]",
      )}
    >
      <Users className="size-3" aria-hidden="true" />
      {sharing.label}
    </span>
  );
};

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
  /**
   * Role per local drive label, for drives shared with this account.
   *
   * Optional and joined by label: rows come from `sync_paths` and roles from
   * the membership listing, so a row can render before its role arrives. A
   * missing entry shows the shared badge without a role rather than guessing.
   */
  rolesByLabel?: ReadonlyMap<string, DriveRole>;
  /**
   * How many people each OWN drive has been shared with, by local label.
   *
   * Absent means "not known yet", which shows no badge — an own drive with
   * nothing known about it must not read as private when it might not be.
   */
  sharingByLabel?: ReadonlyMap<string, DriveSharing>;
  /**
   * Open the sharing surface for a drive. Rendered inline on a drive that has
   * members, where managing who can see it is the likely next action.
   */
  onManageAccess?: (row: FolderRow) => void;
  /**
   * Drives per page. The list is paged because "Shared with me" sits BELOW
   * it: an account with twenty drives pushed the drives other people shared
   * off the bottom of a surface nobody scrolls.
   */
  pageSize?: number;
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
  rolesByLabel,
  sharingByLabel,
  onManageAccess,
  pageSize = FOLDER_LIST_PAGE_SIZE,
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

  const [page, setPage] = useState(1);
  // Clamped rather than trusted: removing the last drive on the last page
  // leaves this index past the end, which would render an empty list under a
  // pager still claiming there are drives.
  const pageView = resolveFolderListPage({
    total: rows.length,
    page,
    pageSize,
  });
  const visibleRows = rows.slice(pageView.start, pageView.end);

  return (
    <SettingsCard
      label={label}
      icon={<Icons.Folder className="size-3.5" />}
      headerAction={headerAction}
    >
      {isLoading ? (
        <div className="flex flex-col">
          {/* Five, not three: three left a short stub of a card that read as
              "you have three folders" mid-load and then jumped. Five fills
              the space a typical list occupies, so the swap to real rows is
              a fill rather than a resize. */}
          {[0, 1, 2, 3, 4].map((i) => (
            <FolderRowSkeleton key={i} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="px-3 py-6">{emptyState}</div>
      ) : (
        <div className="flex flex-col">
          {visibleRows.map((row) => (
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
                  <SharedMark
                    row={row}
                    role={rolesByLabel?.get(row.folderName)}
                    sharing={sharingByLabel?.get(row.folderName)}
                  />
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

                {row.local?.hostedBy && (
                  <HostedRootNote host={row.local.hostedBy} className="mt-1.5 ml-6" />
                )}

                {row.status === "error" && row.local?.errorMessage && (
                  <p className="ml-6 mt-1 text-xs font-medium text-error-50">
                    {row.local.errorMessage}
                  </p>
                )}
              </div>

              {/* A shared drive's most likely next action is deciding who has
                  it, so it gets a control of its own rather than being three
                  clicks into an overflow menu. Only on rows where it means
                  something: an own drive with people in it. */}
              {onManageAccess &&
                // An own drive that has been shared, or somebody else's drive
                // this account manages. A Viewer or Editor gets the role badge
                // and nothing to press.
                (row.ownerSs58
                  ? rolesByLabel?.get(row.folderName) === "manager"
                  : isDriveShared(sharingByLabel?.get(row.folderName))) && (
                  <Button
                    variant="ghost"
                    size="auto"
                    onClick={() => onManageAccess(row)}
                    className="action-menu-area mt-0.5 h-8 flex-shrink-0 rounded-md border border-grey-80 px-2.5 text-xs font-medium text-grey-30 transition-colors hover:bg-grey-90 dark:border-white/10 dark:text-grey-dark-600 dark:hover:bg-white/10"
                  >
                    Manage access
                  </Button>
                )}

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
          {/* Only once the list outgrows a page: a pager that can only say
              "1 of 1" is a control with nothing to do. */}
          {pageView.showPager && (
            <div className="border-t border-grey-dark-100 px-3 py-3 dark:border-black-300">
              <Pagination
                currentPage={pageView.page}
                totalPages={pageView.totalPages}
                setPage={setPage}
              />
            </div>
          )}
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
