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
import { driveRowSharing } from "@/app/lib/shared-drives/driveRowSharing";
import {
  isDriveShared,
  useOwnedDriveSharing,
} from "@/app/lib/hooks/useOwnedDriveSharing";
import { useSharedDriveMembership } from "@/app/lib/hooks/useSharedDriveRoles";

const NO_LABELS: readonly string[] = [];

export default function DriveSharingHeaderMark({
  label,
  displayName,
}: {
  /** The open drive's local label — the key both listings agree on. */
  label: string | null | undefined;
  /** What the breadcrumb calls it, for the manage panel's header. */
  displayName?: string | null;
}) {
  const setShareTarget = useSetAtom(shareDriveModalAtom);
  const { membership, isSettled } = useSharedDriveMembership(label);

  // A member drive's sharing is described by its role; asking the server for
  // its members would be the owner's question, not ours -- and the IPC would
  // refuse the label anyway. So only an OWN drive is looked up, and only once
  // the membership listing has answered: until then every drive looks own,
  // and the wait costs nothing because the badge has nothing to draw yet.
  const ownSharing = useOwnedDriveSharing(
    !label || !isSettled || membership ? NO_LABELS : [label],
  );

  if (!SHARED_DRIVES_ENABLED || !label) return null;

  const sharing = driveRowSharing({
    ownerSs58: membership?.ownerSs58,
    role: membership?.role,
    ...ownSharing.get(label),
  });
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

      {/* Only the owner can manage access. A member sees the badge and their
          role, which is the whole of what the drive means for them here. */}
      {!withMe && isDriveShared(ownSharing.get(label)) && (
        <Button
          variant="ghost"
          size="auto"
          onClick={() =>
            setShareTarget({ label, folderName: displayName ?? label })
          }
          className="h-7 flex-shrink-0 rounded-md border border-grey-80 px-2.5 text-xs font-medium text-grey-30 transition-colors hover:bg-grey-90 dark:border-white/10 dark:text-grey-dark-600 dark:hover:bg-white/10"
        >
          Manage access
        </Button>
      )}
    </div>
  );
}
