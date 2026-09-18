// "Shared with me" — drives other accounts invited this one into, fed by
// `list_my_drive_memberships`. Rendered in BOTH MultiFolderSyncManager
// (settings) and DriveOnboarding (files page); flag-gated and silent in
// every non-rows state (see `sharedWithMeState.ts::getSharedWithMeView`):
// a feature-off server, a failed passive fetch, or zero memberships all
// render nothing — never a toast, never an empty headline.
//
// An unsynced row's "Sync locally" runs: folder picker (last-browse-dir
// chain) → `add_shared_drive` → the drive lands in the NORMAL lists,
// which are the management surface from then on (this section then shows
// the row as synced with its local label). A synced row deliberately has
// no actions here.

"use client";

import React, { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
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
import { middleTruncate } from "@/lib/utils/middleTruncate";
import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import {
  addSharedDrive,
  isSharedDrivesUnavailable,
  leaveSharedDriveByIdentity,
  listMyDriveMemberships,
  type DriveMembershipInfo,
} from "@/app/lib/tauri/sharedDrives";
import {
  getLastBrowseDirectory,
  saveLastBrowseDirectory,
} from "@/app/lib/utils/userPreferencesDb";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import {
  driveRoleLabel,
  parseDriveRole,
} from "@/app/lib/shared-drives/roles";
import {
  getMembershipRowAction,
  getSharedWithMeView,
  type SharedWithMeData,
} from "./sharedWithMeState";

const OwnerAvatar = dynamic(() => import("boring-avatars"), { ssr: false });

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
   * Open the manage-access panel for a drive this account manages. Offered
   * only on a drive synced here — the manage IPCs resolve a local label.
   */
  onManageAccess?: (target: { label: string; folderName: string }) => void;
  /**
   * Fired after `add_shared_drive` succeeds with the allocated local
   * label — the parent refreshes its drive lists (and may navigate to
   * the new drive).
   */
  onDriveAdded?: (label: string) => void;
}

export function SharedWithMeSection({
  onDriveAdded,
  onOpenDrive,
  onManageAccess,
}: SharedWithMeSectionProps) {
  const [data, setData] = useState<SharedWithMeData>({ kind: "idle" });
  // The row whose add_shared_drive call is in flight, keyed by
  // `${ownerSs58}:${folderHash}` (the membership's wire identity).
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // Leaving is irreversible from this surface, so it goes through the app's
  // confirm dialog rather than straight off a menu item.
  const [leaveTarget, setLeaveTarget] = useState<DriveMembershipInfo | null>(null);


  const load = useCallback(async () => {
    setData((prev) => (prev.kind === "ready" ? prev : { kind: "loading" }));
    try {
      const memberships = await listMyDriveMemberships();
      setData({ kind: "ready", memberships });
    } catch (err) {
      if (isSharedDrivesUnavailable(err)) {
        setData({ kind: "unavailable" });
      } else {
        // Passive mount-time fetch: log, render nothing, never toast.
        console.error("Failed to load drive memberships:", err);
        setData({ kind: "error" });
      }
    }
  }, []);

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

  useEffect(() => {
    if (!SHARED_DRIVES_ENABLED) return;
    void load();
  }, [load]);

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
          setData({ kind: "unavailable" });
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
    [onDriveAdded, load],
  );

  if (getSharedWithMeView(SHARED_DRIVES_ENABLED, data) === "hidden") return null;
  const memberships = data.kind === "ready" ? data.memberships : [];

  return (
    <SettingsCard label="Shared with Me" icon={<Users className="size-4" />}>
      <div className="max-h-[420px] overflow-y-auto">
        {memberships.map((membership) => {
          const key = `${membership.ownerSs58}:${membership.folderHash}`;
          const action = getMembershipRowAction(membership);
          const role = parseDriveRole(membership.role);
          const canManage = role === "manager";
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
                  {/* The role as a chip, the shape the drive list already
                      uses for "Shared with N" -- so the two read as one
                      family rather than a badge beside loose text. */}
                  <span className="inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-[#1F50BD]/50 bg-[#1F50BD]/10 px-2 py-0.5 text-[11px] font-medium text-[#1F50BD] dark:border-[#6b93ea]/50 dark:bg-[#6b93ea]/10 dark:text-[#9dbaf2]">
                    <Users className="size-3" aria-hidden="true" />
                    {/* The wire says reader/writer/manager; people read
                        Viewer/Editor/Manager. */}
                    {driveRoleLabel(role)}
                  </span>
                  {action.kind === "synced" && (
                    <span className="flex-shrink-0 whitespace-nowrap text-[11px] font-medium text-[#04c870]">
                      Synced here
                    </span>
                  )}
                </div>
                <p
                  className="ml-6 mt-1 truncate font-geist text-[13px] font-medium text-[#0A0A0A]/40 dark:text-white/40"
                  title={membership.ownerSs58}
                >
                  Shared by {middleTruncate(membership.ownerSs58, 22)}
                </p>
              </div>

              {/* Managing access is a manager's likely next action, so it
                  gets a control of its own rather than a place in the
                  overflow -- the treatment an own shared drive's row has. */}
              {canManage && action.kind === "synced" && onManageAccess && (
                <Button
                  variant="ghost"
                  size="auto"
                  onClick={() =>
                    onManageAccess({
                      label: action.localLabel,
                      folderName: membership.displayLabel,
                    })
                  }
                  className="row-action-area mt-0.5 h-8 flex-shrink-0 rounded-md border border-grey-80 px-2.5 text-xs font-medium text-grey-30 transition-colors hover:bg-grey-90 dark:border-white/10 dark:text-grey-dark-600 dark:hover:bg-white/10"
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
      </div>

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
    </SettingsCard>
  );
}
