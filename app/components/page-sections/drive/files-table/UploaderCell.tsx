"use client";

import CustomTooltip2 from "@/components/ui/CustomTooltip2";
import {
  accountDisplayName,
  presentText,
} from "@/app/lib/shared-drives/accountLabel";
import { cn } from "@/lib/utils";
import { displayEmail } from "@/lib/utils/displayEmail";
import AccountLabel from "../AccountLabel";

/**
 * Who added a file, in a shared drive.
 *
 * Mirrors hippius-web's UploaderCell: You / Owner / name-or-truncated-ss58 /
 * dash for folders and unknown, with muted "Owner" when attribution was
 * never recorded (drive was private until shared).
 */
export default function UploaderCell({
  uploadedBy,
  uploadedByName,
  uploadedByEmail,
  isFolder,
  sessionSs58,
  driveOwnerSs58,
  driveOwnerName,
  className,
}: {
  uploadedBy?: string | null;
  uploadedByName?: string;
  uploadedByEmail?: string;
  isFolder?: boolean;
  sessionSs58?: string;
  driveOwnerSs58?: string;
  driveOwnerName?: string;
  className?: string;
}) {
  const muted = "text-grey-60 dark:text-grey-dark-700";
  const name = presentText(uploadedByName);
  const email = displayEmail(uploadedByEmail);

  if (isFolder) {
    return (
      <span
        className={cn(muted, className)}
        title="A folder is not added by anyone: it is where its files live"
      >
        —
      </span>
    );
  }

  if (!uploadedBy) {
    if (!driveOwnerSs58) {
      return (
        <span
          className={cn(muted, className)}
          title="Added before Hippius recorded who uploaded each file"
        >
          —
        </span>
      );
    }
    return (
      <CustomTooltip2
        side="bottom"
        tooltipContent={
          <span>
            Not recorded. This file predates Hippius recording who uploaded
            what, and the drive was private until it was shared, so the owner
            ({accountDisplayName(driveOwnerSs58, driveOwnerName)}) added it.
          </span>
        }
      >
        <span className={cn(muted, className)}>Owner</span>
      </CustomTooltip2>
    );
  }

  if (sessionSs58 && uploadedBy === sessionSs58) {
    return <span className={className}>You</span>;
  }

  if (driveOwnerSs58 && uploadedBy === driveOwnerSs58) {
    return (
      <CustomTooltip2
        side="bottom"
        tooltipContent={
          <span className="flex flex-col gap-0.5">
            {name ? <span className="font-medium">{name}</span> : null}
            <span className="break-all font-mono text-xs">{uploadedBy}</span>
            {email ? <span className="break-all text-xs">{email}</span> : null}
          </span>
        }
      >
        <span className={className}>Owner</span>
      </CustomTooltip2>
    );
  }

  // 28 chars fits the ~18% Added by column; 22 was too aggressive in the
  // old skinny cell and still left CSS truncate fighting the middle ellipsis.
  return (
    <AccountLabel
      ss58={uploadedBy}
      name={name}
      email={uploadedByEmail}
      maxChars={28}
      className={cn(!name && "text-xs", className)}
    />
  );
}
