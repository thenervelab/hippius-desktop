"use client";

// One FOLDER shared with this account (folder roles, HCFS #475): its own row
// in "Shared with me", beside the whole drives. It names the folder, the
// drive it lives in and who owns it, carries the role chip (Viewer or
// Editor), and offers Open (rooted at the folder) and Leave. No Manage
// access: only the owner manages, so a holder never manages the folder.
// No "Sync to this computer": syncing a granted folder to disk is not
// supported.

import React from "react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Icons } from "@/components/ui";
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
