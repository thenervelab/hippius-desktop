// "Shared with me" — drives other accounts invited this one into, fed by
// `list_my_drive_memberships`. Rendered in BOTH MultiFolderSyncManager
// (settings) and the Shared Drives page, flag-gated. In Settings it is
// silent in every non-rows state; on the Shared Drives page (`alwaysShow`)
// it is always there, with skeleton rows while loading and the page's empty
// text when nothing is shared (see `sharedWithMeState.ts::getSharedWithMeView`).
// The Shared Drives page draws only its rows (`variant="rows"`), inside the
// page's one list, from the page's memberships fetch and in the slice the
// page's pager asks for. Never a toast.
//
// An unsynced row's "Sync locally" runs: folder picker (last-browse-dir
// chain) → `add_shared_drive` → the drive lands in the NORMAL lists,
// which are the management surface from then on (this section then shows
// the row as synced with its local label). A synced row deliberately has
// no actions here.

"use client";

import React, { useCallback, useMemo, useState } from "react";
import { Users } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Icons } from "@/components/ui";
import TableActionMenu from "@/components/ui/alt-table/TableActionMenu";
import ConfirmationDialog from "@/components/ConfirmationDialog";
import { buildSharedDriveActions } from "./sharedDriveRowActions";
import { SettingsCard } from "../SettingsCard";
import FolderRowSkeleton from "./FolderRowSkeleton";
import AccountLabel from "@/components/page-sections/drive/AccountLabel";
import { frozenNotice } from "@/app/lib/shared-drives/writeRefusal";
import { formatBytes } from "@/lib/utils/formatBytes";
import { formatRowDate } from "@/components/page-sections/drive/folder-list/formatRowDate";
import { RowDot as Dot } from "@/components/page-sections/drive/folder-list/RowDot";
import DriveRoleChip from "@/components/page-sections/drive/DriveRoleChip";
import {
  sharedDriveStatsKey,
  useSharedDriveStats,
} from "@/app/lib/hooks/useSharedDriveStats";
import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import {
  addSharedDrive,
  isSharedDrivesUnavailable,
  leaveSharedDriveByIdentity,
  type DriveMembershipInfo,
  type MyFolderGrantInfo,
} from "@/app/lib/tauri/sharedDrives";
import {
  getLastBrowseDirectory,
  saveLastBrowseDirectory,
} from "@/app/lib/utils/userPreferencesDb";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { canManageDrive, parseDriveRole } from "@/app/lib/shared-drives/roles";
import {
  folderGrantRowView,
  getMembershipRowAction,
  getSharedWithMeView,
} from "./sharedWithMeState";
import { useDriveMemberships, type DriveMemberships } from "./useDriveMemberships";
import SharedFolderGrantRow from "./SharedFolderGrantRow";
import { useQueryClient } from "@tanstack/react-query";
import {
  MY_FOLDER_GRANTS_QUERY_KEY,
  useMyFolderGrants,
} from "@/app/lib/hooks/useSharedDriveRoles";
import type { ShareDriveModalTarget } from "@/app/lib/global-atoms/sharesAtoms";

interface SharedWithMeSectionProps {
  /**
   * Open a drive for browsing without syncing it here.
   *
   * The row used to offer only "Sync locally", which made looking at what
   * somebody shared conditional on copying it to this machine. Browsing needs
   * no local copy and no folder key: `/browse` authorises any member of the
   * drive and returns names and paths in plaintext.
   *
   * Omitted on surfaces with nowhere to browse to (Settings), where the row
   * stays a plain row.
   */
  onOpenDrive?: (identity: {
    ownerSs58: string;
    folderHash: string;
    displayLabel: string;
  }) => void;
  /**
   * Open the manage-access panel for a drive this account manages. The
   * target names the owner's drive when it is not synced here.
   */
  onManageAccess?: (target: ShareDriveModalTarget) => void;
  /**
   * Open a FOLDER shared with this account (folder roles), rooted at that
   * folder. Omitted where there is nowhere to browse to.
   */
  onOpenFolderGrant?: (grant: {
    ownerSs58: string;
    folderHash: string;
    pathPrefix: string;
    folderName: string;
  }) => void;
  /**
   * Fired after `add_shared_drive` succeeds with the allocated local
   * label — the parent refreshes its drive lists (and may navigate to
   * the new drive).
   */
  onDriveAdded?: (label: string) => void;
  /** Card heading. "Shared with Me" unless the page names its sections otherwise. */
  label?: string;
  /**
   * Keep the section on screen with nothing shared, with `emptyState` in it
   * (the Shared Drives page). Off, the section shows only rows (Settings).
   */
  alwaysShow?: boolean;
  /** What an empty section says, on a page that keeps it up. */
  emptyState?: React.ReactNode;
  /**
   * The memberships fetch, when the page already holds it (the Shared
   * Drives page reads the same answer for its tab counts). Without it the
   * section fetches for itself.
   */
  memberships?: DriveMemberships;
  /**
   * `"card"` (default): the section's own card, heading and states.
   * `"rows"`: only the rows, for a list the page frames itself (the Shared
   * Drives page's one list); nothing at all while there are no rows, since
   * the page draws the loading and empty states.
   */
  variant?: "card" | "rows";
  /**
   * Which rows to draw, as a half-open range over the drives followed by
   * the folders (the page's pager). All of them when absent.
   */
  slice?: { start: number; end: number };
}

export function SharedWithMeSection({
  onDriveAdded,
  onOpenDrive,
  onManageAccess,
  onOpenFolderGrant,
  label = "Shared with Me",
  alwaysShow = false,
  emptyState,
  memberships: membershipsFromPage,
  variant = "card",
  slice,
}: SharedWithMeSectionProps) {
  const queryClient = useQueryClient();
  // Folders shared with this account: only once folder roles are on (the
  // hook fetches nothing otherwise), each its own row below the drives.
  const { grants: folderGrants, isSettled: grantsSettled } = useMyFolderGrants();
  const [leaveGrant, setLeaveGrant] = useState<MyFolderGrantInfo | null>(null);
  const ownMemberships = useDriveMemberships(!membershipsFromPage);
  const { data, reload: load, markUnavailable } = membershipsFromPage ?? ownMemberships;
  // The row whose add_shared_drive call is in flight, keyed by
  // `${ownerSs58}:${folderHash}` (the membership's wire identity).
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // Leaving is irreversible from this surface, so it goes through the app's
  // confirm dialog rather than straight off a menu item.
  const [leaveTarget, setLeaveTarget] = useState<DriveMembershipInfo | null>(null);
  // Size and counts live only on the OWNER's listing; the membership rows
  // carry none. Hooks run before the view's early returns, so the owners are
  // read off whatever the fetch currently holds.
  const owners = useMemo(
    () =>
      data.kind === "ready" ? data.memberships.map((m) => m.ownerSs58) : [],
    [data],
  );
  const statsByDrive = useSharedDriveStats(owners);

  /**
   * Leave by WIRE identity, not by local label: a drive listed here may never
   * have been synced to this machine, and the label-keyed command resolves a
   * `sync_paths` row that does not exist.
   */
  const leaveDrive = useCallback(
    async (membership: DriveMembershipInfo) => {
      try {
        await leaveSharedDriveByIdentity(membership.ownerSs58, membership.folderHash);
        toast.success(`Left "${membership.displayLabel}"`);
        await load();
      } catch (err) {
        if (isSharedDrivesUnavailable(err)) return;
        toast.error(`Could not leave the drive: ${errorMessage(err)}`);
      }
    },
    [load],
  );

  const syncLocally = useCallback(
    async (membership: DriveMembershipInfo) => {
      const key = `${membership.ownerSs58}:${membership.folderHash}`;
      try {
        const defaultPath = await getLastBrowseDirectory();
        const picked = await openDialog({
          directory: true,
          multiple: false,
          title: `Select where to sync "${membership.displayLabel}"`,
          defaultPath,
        });
        if (typeof picked !== "string") return;
        await saveLastBrowseDirectory(picked);

        setBusyKey(key);
        const result = await addSharedDrive(
          membership.ownerSs58,
          membership.folderHash,
          picked,
          membership.displayLabel,
        );
        toast.success(`Started syncing "${result.label}"`);
        onDriveAdded?.(result.label);
        await load();
      } catch (err) {
        if (isSharedDrivesUnavailable(err)) {
          markUnavailable();
        } else {
          // Verbatim: a Validation refusal names the existing label/path
          // ("already set up as ..."), which is exactly what the user
          // needs to find the drive.
          toast.error(errorMessage(err));
        }
      } finally {
        setBusyKey(null);
      }
    },
    [onDriveAdded, load, markUnavailable],
  );

  /**
   * Leaving a folder removes this account's access to the drive's granted
   * folders (the server's member DELETE clears every grant on that drive).
   */
  const leaveFolderGrant = async (grant: MyFolderGrantInfo) => {
    try {
      await leaveSharedDriveByIdentity(grant.ownerSs58, grant.folderHash);
      toast.success(`Left "${folderGrantRowView(grant).folderName}"`);
      await queryClient.invalidateQueries({ queryKey: [MY_FOLDER_GRANTS_QUERY_KEY] });
    } catch (err) {
      if (isSharedDrivesUnavailable(err)) return;
      toast.error(`Could not leave the folder: ${errorMessage(err)}`);
    }
  };

  const view = getSharedWithMeView(SHARED_DRIVES_ENABLED, data, folderGrants.length, {
    alwaysShow,
    grantsSettled,
  });
  if (view === "hidden") return null;
  const memberships = data.kind === "ready" ? data.memberships : [];
  // Drives first, then folders, as one sequence the page's pager windows.
  const inSlice = (index: number) =>
    !slice || (index >= slice.start && index < slice.end);
  const shownMemberships = memberships.filter((_, i) => inSlice(i));
  const shownGrants = folderGrants.filter((_, i) => inSlice(memberships.length + i));

  if (variant === "rows" && view !== "rows") return null;

  if (view === "loading" || view === "empty") {
    return (
      <SettingsCard label={label} icon={<Users className="size-4" />}>
        {view === "empty" ? (
          emptyState
        ) : (
          <div aria-busy="true" aria-label="Loading drives shared with you">
            <FolderRowSkeleton />
            <FolderRowSkeleton />
          </div>
        )}
      </SettingsCard>
    );
  }

  const rows = (
    <div
      className={cn(
        variant === "card"
          ? "max-h-[420px] overflow-y-auto"
          : // A line between rows, as the page's own drives have.
            "[&>*+*]:border-t [&>*+*]:border-grey-dark-100 dark:[&>*+*]:border-black-300",
      )}
    >
      {shownMemberships.map((membership) => {
        const key = `${membership.ownerSs58}:${membership.folderHash}`;
        const action = getMembershipRowAction(membership);
        const role = parseDriveRole(membership.role);
        // A Manager manages this drive for its owner, from here as from
        // inside it. A Viewer or an Editor gets the role and Leave.
        const canManage = canManageDrive({ isOwner: false, role });
        const manageTarget: ShareDriveModalTarget = {
          // A synced drive resolves by its local label; one that is not
          // names its wire identity instead.
          label: action.kind === "synced" ? action.localLabel : membership.displayLabel,
          folderName: membership.displayLabel,
          ...(action.kind === "synced"
            ? {}
            : { ownerSs58: membership.ownerSs58, folderHash: membership.folderHash }),
        };
        const manage = canManage && onManageAccess ? () => onManageAccess(manageTarget) : undefined;
        const stats = statsByDrive.get(sharedDriveStatsKey(membership));
        return (
          <div
            key={key}
            role={onOpenDrive ? "button" : undefined}
            tabIndex={onOpenDrive ? 0 : undefined}
            // Named, or the row's accessible name is every word it
            // contains -- including its own "Sync locally" button's.
            aria-label={onOpenDrive ? `Open ${membership.displayLabel}` : undefined}
            onClick={
              onOpenDrive
                ? (e) => {
                    // The row's own buttons are not opens.
                    if ((e.target as HTMLElement).closest(".row-action-area")) return;
                    onOpenDrive({
                      ownerSs58: membership.ownerSs58,
                      folderHash: membership.folderHash,
                      displayLabel: membership.displayLabel,
                    });
                  }
                : undefined
            }
            onKeyDown={
              onOpenDrive
                ? (e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    onOpenDrive({
                      ownerSs58: membership.ownerSs58,
                      folderHash: membership.folderHash,
                      displayLabel: membership.displayLabel,
                    });
                  }
                : undefined
            }
            className={cn(
              "flex items-center justify-between gap-3 p-3 hover:bg-grey-light-400 dark:hover:bg-white/5",
              onOpenDrive && "cursor-pointer",
              membership.frozen && "opacity-80",
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {/* A folder, drawn like every other drive. The owner's
                    identicon used to sit here, which made a shared drive
                    look like a person rather than a place for files --
                    and the owner is already named on the line below. */}
                <Icons.Folder className="size-4 flex-shrink-0 text-[#1F50BD]" />
                <span
                  className="truncate font-geist text-[14px] font-medium text-[#0A0A0A] dark:text-white"
                  title={membership.displayLabel}
                >
                  {membership.displayLabel}
                </span>
                {/* The console's role chip, ported verbatim: colour
                    carries the same ordering the roles do, so a list can
                    be read for access at a glance. */}
                <DriveRoleChip role={role} />
                {membership.frozen && (
                  <span
                    className="flex-shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium text-grey-50 dark:text-grey-dark-600"
                    title={frozenNotice(membership.frozenUntil)}
                  >
                    Frozen
                  </span>
                )}
                {action.kind === "synced" && (
                  <span className="flex-shrink-0 whitespace-nowrap text-[11px] font-medium text-[#04c870]">
                    Synced here
                  </span>
                )}
                {/* A drive whose owner's listing has not come back is
                    UNKNOWN, not empty. Rendering it as "0 B · 0 files"
                    claims the drive is empty when nobody successfully
                    asked -- so an absent entry shows nothing at all. */}
                {stats && (
                  <>
                    <span className="h-4 w-px flex-shrink-0 bg-grey-80 dark:bg-[#3a3a3a]" />
                    <span className="flex items-center gap-1 whitespace-nowrap text-xs text-grey-60 dark:text-grey-dark-600">
                      <Icons.Database className="size-3.5 text-[#1F50BD]" />
                      {formatBytes(stats.totalBytes)}
                    </span>
                    <Dot />
                    <span className="flex items-center gap-1 whitespace-nowrap text-xs text-grey-60 dark:text-grey-dark-600">
                      <Icons.Folders className="size-3.5 text-[#1F50BD]" />
                      {stats.fileCount} {stats.fileCount === 1 ? "file" : "files"}
                    </span>
                    {stats.updatedAt > 0 && (
                      <>
                        <Dot />
                        <span className="flex items-center gap-1 whitespace-nowrap text-xs text-grey-60 dark:text-grey-dark-600">
                          <Icons.Clock8 className="size-3.5 text-[#1F50BD]" />
                          {/* The wire is SECONDS; the formatter takes ms. */}
                          {formatRowDate(stats.updatedAt * 1000)}
                        </span>
                      </>
                    )}
                  </>
                )}
              </div>
              <div className="ml-6 mt-1 flex min-w-0 items-center gap-1 font-geist text-[13px] font-medium text-[#0A0A0A]/40 dark:text-white/40">
                <span className="shrink-0">Shared by</span>
                <AccountLabel
                  ss58={membership.ownerSs58}
                  name={membership.ownerName}
                />
                {/* Zero and absent both draw nothing, never fake "0 members"
                    off a missing count (console OwnerCell parity). */}
                {membership.memberCount ? (
                  <span className="shrink-0 whitespace-nowrap">
                    · {membership.memberCount}{" "}
                    {membership.memberCount === 1 ? "member" : "members"}
                  </span>
                ) : null}
              </div>
            </div>

            {/* Managing access is a manager's likely next action, so it
                gets a control of its own rather than a place in the
                overflow -- the treatment an own shared drive's row has. */}
            {/* No longer conditional on a local copy: the manage calls
                address the drive by its wire identity, so a manager can
                manage one they have never synced here. */}
            {manage && (
              <Button
                variant="ghost"
                size="auto"
                onClick={manage}
                className="row-action-area mt-0.5 h-8 flex-shrink-0 rounded-md border border-primary-50 px-2.5 text-xs font-medium text-primary-50 transition-colors hover:bg-primary-50/10 dark:border-primary-brand-dark dark:text-primary-brand-dark dark:hover:bg-primary-50/15"
              >
                Manage access
              </Button>
            )}

            <TableActionMenu
              dropdownTitle=""
              items={buildSharedDriveActions({
                membership,
                role,
                isSynced: action.kind === "synced",
                busy: busyKey !== null,
                onOpen: onOpenDrive
                  ? () =>
                      onOpenDrive({
                        ownerSs58: membership.ownerSs58,
                        folderHash: membership.folderHash,
                        displayLabel: membership.displayLabel,
                      })
                  : undefined,
                onSyncLocally: () => void syncLocally(membership),
                onManageAccess: manage,
                onLeave: () => setLeaveTarget(membership),
              })}
            >
              <Button
                variant="ghost"
                size="auto"
                aria-label={`Actions for ${membership.displayLabel}`}
                className="row-action-area mt-0.5 h-8 w-8 flex-shrink-0 rounded-md p-0 text-grey-70 transition-colors hover:bg-grey-90 hover:text-grey-30 dark:text-grey-dark-600 dark:hover:bg-white/10 dark:hover:text-white"
              >
                <Icons.EllipsisVertical className="size-[18px]" />
              </Button>
            </TableActionMenu>
          </div>
          );
      })}
      {shownGrants.map((grant) => {
        const view = folderGrantRowView(grant);
        return (
          <SharedFolderGrantRow
            key={view.key}
            grant={grant}
            onOpen={
              onOpenFolderGrant
                ? () =>
                    onOpenFolderGrant({
                      ownerSs58: grant.ownerSs58,
                      folderHash: grant.folderHash,
                      pathPrefix: view.path,
                      folderName: view.folderName,
                    })
                : undefined
            }
            onLeave={() => setLeaveGrant(grant)}
          />
          );
      })}
    </div>
  );

  const dialogs = (
    <>
      <ConfirmationDialog
        open={leaveGrant !== null}
        onClose={() => setLeaveGrant(null)}
        onBack={() => setLeaveGrant(null)}
        onConfirm={() => {
          const target = leaveGrant;
          setLeaveGrant(null);
          if (target) void leaveFolderGrant(target);
        }}
        heading="Leave shared folder"
        icon={<Icons.Trash className="size-4 text-white" />}
        iconBgColor="bg-[#fc7d73]"
        confirmVariant="destructive"
        confirmButtonClassName="text-white"
        button="Leave folder"
        text={`Leave "${leaveGrant ? folderGrantRowView(leaveGrant).folderName : ""}"?`}
        helperText="You lose access to it, and to any other folder of the same drive shared with you. The owner can invite you again."
      />

      <ConfirmationDialog
        open={leaveTarget !== null}
        onClose={() => setLeaveTarget(null)}
        onBack={() => setLeaveTarget(null)}
        onConfirm={() => {
          const target = leaveTarget;
          setLeaveTarget(null);
          if (target) void leaveDrive(target);
        }}
        heading="Leave shared drive"
        icon={<Icons.Trash className="size-4 text-white" />}
        iconBgColor="bg-[#fc7d73]"
        confirmVariant="destructive"
        confirmButtonClassName="text-white"
        button="Leave drive"
        text={`Leave "${leaveTarget?.displayLabel ?? ""}"?`}
        helperText="You lose access to its files. Anything already downloaded to this computer stays, and the owner can invite you again."
      />
    </>
  );

  if (variant === "rows") {
    return (
      <>
        {shownMemberships.length + shownGrants.length > 0 ? rows : null}
        {dialogs}
      </>
    );
  }

  return (
    <SettingsCard label={label} icon={<Users className="size-4" />}>
      {rows}
      {dialogs}
    </SettingsCard>
  );
}
