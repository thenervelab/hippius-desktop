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
import { driveRowSharing } from "@/app/lib/shared-drives/driveRowSharing";
import { parseDriveRole } from "@/app/lib/shared-drives/roles";

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
  const canManage = browsedSharedDrive
    // Managing resolves a LOCAL label, so a drive browsed without being
    // synced here has nothing to resolve. Sync it first.
    ? browsedRole === "manager" && Boolean(byIdentity.membership?.localLabel)
    : bySynced.canManage;

  if (!sharing.isShared) return null;

  const withMe = sharing.direction === "with-me";

  return (
    <div className="flex min-w-0 items-center gap-2">
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

      {/* Owners, and managers on a drive they do not own. A Viewer or Editor
          sees the badge and their role, which is the whole of what the drive
          means for them here. */}
      {canManage && (
        <Button
          variant="ghost"
          size="auto"
          onClick={() =>
            setShareTarget({
              // The manage IPCs resolve a LOCAL label. A browsed drive that is
              // also synced here has one; one that is not cannot be managed
              // from this surface yet, and the button is withheld above.
              label: byIdentity.membership?.localLabel ?? label,
              folderName: displayName ?? label,
            })
          }
          className="h-7 flex-shrink-0 rounded-md border border-grey-80 px-2.5 text-xs font-medium text-grey-30 transition-colors hover:bg-grey-90 dark:border-white/10 dark:text-grey-dark-600 dark:hover:bg-white/10"
        >
          Manage access
        </Button>
      )}
    </div>
  );
}
