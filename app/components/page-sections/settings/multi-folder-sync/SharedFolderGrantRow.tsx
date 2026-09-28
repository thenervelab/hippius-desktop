"use client";

// One FOLDER shared with this account (folder roles, HCFS #475): its own row
// in "Shared with me", beside the whole drives. It names the folder, the
// drive it lives in and who owns it, carries the role chip (Viewer or
// Editor), and offers Open (rooted at the folder) and Leave. No Manage
// access: Manager is not a folder role, so a holder never manages the folder.
// No "Sync to this computer": syncing a granted folder to disk is not
// supported.
//
// Its size and file count are the FOLDER's own, from browsing the folder
// (`folder_grant_stats`), never the drive's totals, which would overstate
// it: a skeleton while they load, a dash if they cannot be read. No member
// count: the server does not tell a holder how many people reach a folder.

import React from "react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Icons, Skeleton } from "@/components/ui";
import { formatBytes } from "@/lib/utils/formatBytes";
import { RowDot as Dot } from "@/components/page-sections/drive/folder-list/RowDot";
import { useFolderGrantStats } from "@/app/lib/hooks/useFolderGrantStats";
import TableActionMenu from "@/components/ui/alt-table/TableActionMenu";
import AccountLabel from "@/components/page-sections/drive/AccountLabel";
import DriveRoleChip from "@/components/page-sections/drive/DriveRoleChip";
import { frozenNotice } from "@/app/lib/shared-drives/writeRefusal";
import { parseDriveRole } from "@/app/lib/shared-drives/roles";
import type { MyFolderGrantInfo } from "@/app/lib/tauri/sharedDrives";
import { buildFolderGrantActions } from "./sharedDriveRowActions";
import { folderGrantRowView } from "./sharedWithMeState";

export default function SharedFolderGrantRow({
  grant,
  onOpen,
  onLeave,
}: {
  grant: MyFolderGrantInfo;
  onOpen?: () => void;
  onLeave: () => void;
}) {
  const view = folderGrantRowView(grant);
  const role = parseDriveRole(grant.role);
  const size = useFolderGrantStats(grant);

  return (
    <div
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      aria-label={onOpen ? `Open ${view.folderName}` : undefined}
      onClick={
        onOpen
          ? (e) => {
              if ((e.target as HTMLElement).closest(".row-action-area")) return;
              onOpen();
            }
          : undefined
      }
      onKeyDown={
        onOpen
          ? (e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onOpen();
            }
          : undefined
      }
      className={cn(
        "flex items-center justify-between gap-3 p-3 hover:bg-grey-light-400 dark:hover:bg-white/5",
        onOpen && "cursor-pointer",
        grant.frozen && "opacity-80",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Icons.Folder className="size-4 flex-shrink-0 text-[#1F50BD]" />
          <span
            className="min-w-0 truncate font-geist text-[14px] font-medium text-[#0A0A0A] dark:text-white"
            title={view.path}
          >
            {view.folderName}
          </span>
          <DriveRoleChip role={role} />
          {grant.frozen && (
            <span
              className="flex-shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium text-grey-50 dark:text-grey-dark-600"
              title={frozenNotice(grant.frozenUntil)}
            >
              Frozen
            </span>
          )}
          <span className="h-4 w-px flex-shrink-0 bg-grey-80 dark:bg-[#3a3a3a]" />
          {size.kind === "loading" ? (
            <span role="status" aria-label="Loading folder size" className="inline-flex items-center">
              <Skeleton width={96} height={12} className="rounded-full" />
            </span>
          ) : size.kind === "failed" ? (
            <span
              className="flex items-center gap-1 whitespace-nowrap text-xs text-grey-60 dark:text-grey-dark-600"
              title="Couldn't read this folder's size"
            >
              <Icons.Database className="size-3.5 text-[#1F50BD]" />
              —
            </span>
          ) : (
            <>
              <span
                className="flex items-center gap-1 whitespace-nowrap text-xs text-grey-60 dark:text-grey-dark-600"
                title={size.stats.truncated ? "At least this much: the folder is too large to count in full" : undefined}
              >
                <Icons.Database className="size-3.5 text-[#1F50BD]" />
                {size.stats.truncated ? "≥ " : ""}
                {formatBytes(size.stats.totalBytes)}
              </span>
              <Dot />
              <span className="flex items-center gap-1 whitespace-nowrap text-xs text-grey-60 dark:text-grey-dark-600">
                <Icons.Folders className="size-3.5 text-[#1F50BD]" />
                {size.stats.fileCount} {size.stats.fileCount === 1 ? "file" : "files"}
              </span>
            </>
          )}
        </div>
        <div className="ml-6 mt-1 flex min-w-0 flex-wrap items-center gap-x-1 font-geist text-[13px] font-medium text-[#0A0A0A]/40 dark:text-white/40">
          <span className="min-w-0 truncate" title={view.driveName}>
            In {view.driveName}
          </span>
          <span className="shrink-0">· Shared by</span>
          <AccountLabel ss58={grant.ownerSs58} name={grant.ownerName} />
        </div>
      </div>

      <TableActionMenu dropdownTitle="" items={buildFolderGrantActions({ onOpen, onLeave })}>
        <Button
          variant="ghost"
          size="auto"
          aria-label={`Actions for ${view.folderName}`}
          className="row-action-area mt-0.5 h-8 w-8 flex-shrink-0 rounded-md p-0 text-grey-70 transition-colors hover:bg-grey-90 hover:text-grey-30 dark:text-grey-dark-600 dark:hover:bg-white/10 dark:hover:text-white"
        >
          <Icons.EllipsisVertical className="size-[18px]" />
        </Button>
      </TableActionMenu>
    </div>
  );
}
