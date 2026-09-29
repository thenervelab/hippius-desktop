"use client";

// What the header says about the drive you are standing in.
//
// The drive list marks a shared drive on its row, but that mark is gone the
// moment you open the drive -- and inside is exactly where "who else can see
// this?" is worth asking, because it is where the files are. This puts the
// same mark, and the same way in to managing access, beside the breadcrumb.

import React from "react";
import { Users } from "lucide-react";
import { useSetAtom } from "jotai";

import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import { shareDriveModalAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { useDriveSharing } from "@/app/lib/hooks/useDriveSharing";
import { useSharedDriveMembershipByIdentity } from "@/app/lib/hooks/useSharedDriveRoles";
import { driveRowSharing, managedDriveCountMark } from "@/app/lib/shared-drives/driveRowSharing";
import { canManageDrive, parseDriveRole } from "@/app/lib/shared-drives/roles";
import DriveRoleChip from "./DriveRoleChip";

export default function DriveSharingHeaderMark({
  label,
  displayName,
  browsedSharedDrive = null,
}: {
  /** The open drive's local label — the key both listings agree on. */
  label: string | null | undefined;
  /** What the breadcrumb calls it, for the manage panel's header. */
  displayName?: string | null;
  /**
   * Set when the drive is being browsed WITHOUT being synced here: it has no
   * local label, so its membership is found by wire identity instead.
   */
  browsedSharedDrive?: { ownerSs58: string; folderHash: string } | null;
}) {
  const setShareTarget = useSetAtom(shareDriveModalAtom);
  const bySynced = useDriveSharing(browsedSharedDrive ? null : label);
  const byIdentity = useSharedDriveMembershipByIdentity(browsedSharedDrive);

  if (!SHARED_DRIVES_ENABLED || !label) return null;

  // A browsed drive is somebody else's by construction, so it reads as
  // "with-me" and its role comes straight off the membership.
  const browsedRole = byIdentity.membership
    ? parseDriveRole(byIdentity.membership.role)
    : null;
  const sharing = browsedSharedDrive
    ? driveRowSharing({
        ownerSs58: byIdentity.membership?.ownerSs58 ?? browsedSharedDrive.ownerSs58,
        role: byIdentity.membership?.role,
      })
    : bySynced.sharing;
  // The owner of a shared drive, or a Manager of somebody else's, manages
  // access. Managing needs no local copy: the manage calls address the drive
  // by its wire identity (`?owner=`), and the mint falls back to this
  // account's own grant for the key when no seal is on disk.
  const canManage = browsedSharedDrive
    ? canManageDrive({ isOwner: false, role: browsedRole ?? undefined })
    : bySynced.canManage;
  const memberCount = browsedSharedDrive
    ? (byIdentity.membership?.memberCount ?? null)
    : bySynced.memberCount;

  if (!sharing.isShared) return null;

  const withMe = sharing.direction === "with-me";
  // The role this account holds here, when it is known: a member drive is
  // described by what the viewer may do in it, not by the word "Shared".
  const heldRole = browsedSharedDrive ? browsedRole : bySynced.role;
  // A Manager sees the drive's own mark beside their role, as its owner
  // would: how many people are in it, when the listing says.
  const countMark = withMe && canManage ? managedDriveCountMark(memberCount) : null;

  return (
    <div className="flex min-w-0 items-center gap-2">
      {withMe && heldRole ? (
        <DriveRoleChip role={heldRole} />
      ) : (
      <span
        title={sharing.title ?? undefined}
        className={cn(
          "inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium",
          withMe
            ? "border-[#1F50BD]/50 bg-[#1F50BD]/10 text-[#1F50BD] dark:border-[#6b93ea]/50 dark:bg-[#6b93ea]/10 dark:text-[#9dbaf2]"
            : "border-[#1F50BD]/40 text-[#1F50BD] dark:border-[#6b93ea]/40 dark:text-[#9dbaf2]",
        )}
      >
        <Users className="size-3" aria-hidden="true" />
        {sharing.label}
      </span>
      )}

      {/* Left out on a phone, where the role, the count and the button do
          not fit beside the breadcrumb; the panel says who is in it. */}
      {countMark ? (
        <span
          title={countMark.title}
          className="hidden flex-shrink-0 sm:inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[#1F50BD]/40 px-2 py-0.5 text-[11px] font-medium text-[#1F50BD] dark:border-[#6b93ea]/40 dark:text-[#9dbaf2]"
        >
          <Users className="size-3" aria-hidden="true" />
          {countMark.label}
        </span>
      ) : null}

      {/* Owners and managers manage access. A Viewer or Editor opens the
          same panel read only: who else is in the drive, and Leave. */}
      {canManage || withMe ? (
        <Button
          variant="ghost"
          size="auto"
          onClick={() =>
            setShareTarget({
              // A synced drive resolves by its local label; one that is not
              // synced here names its wire identity instead, which is what
              // lets the manage calls address somebody else's namespace.
              label: byIdentity.membership?.localLabel ?? label,
              folderName: displayName ?? label,
              ...(browsedSharedDrive && !byIdentity.membership?.localLabel
                ? {
                    ownerSs58: browsedSharedDrive.ownerSs58,
                    folderHash: browsedSharedDrive.folderHash,
                  }
                : {}),
            })
          }
          className="h-7 flex-shrink-0 rounded-md border border-primary-50 px-2.5 text-xs font-medium text-primary-50 transition-colors hover:bg-primary-50/10 dark:border-primary-brand-dark dark:text-primary-brand-dark dark:hover:bg-primary-50/15"
        >
          {canManage ? "Manage access" : "Who has access"}
        </Button>
      ) : null}
    </div>
  );
}
