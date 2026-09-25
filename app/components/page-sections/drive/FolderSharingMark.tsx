"use client";

// The mark on a folder that is shared on its own: a folder invite or a folder
// grant, while the drive around it is not shared (or is shared with other
// people, who the drive's own mark counts). Owner only.
//
// Same visual language as the drive mark ("Shared with 2", a people icon, the
// same outline pill), so a shared folder reads like a shared drive, one level
// down. Clicking it opens Manage access scoped to this folder, and stops the
// click there: the row around it is a link that opens the folder.
//
// Beside the pill sits the folder's own "Manage access" button, the compact
// cousin of the one in the drive header, so the way in to that folder's
// people and links is visible rather than only in the row menu. It is words
// where the name cell has room and an icon where it does not: the name cell
// is an `@container`, and anywhere without one the button stays an icon.

import React from "react";
import { UserCog, Users } from "lucide-react";
import { useSetAtom } from "jotai";

import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import { shareDriveModalAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { useOwnedFolderSharingAt } from "@/app/lib/hooks/useOwnedFolderSharing";
import {
  folderRowSharing,
  folderSharingKey,
} from "@/app/lib/shared-drives/folderRowSharing";

/** The drive mark's "shared by me" pill, shared so the two cannot drift. */
export const SHARED_BY_ME_PILL_CLASS =
  "inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium border-[#1F50BD]/40 text-[#1F50BD] dark:border-[#6b93ea]/40 dark:text-[#9dbaf2]";

export default function FolderSharingMark({
  label,
  folderPath,
  folderName,
  compact = false,
  className,
}: {
  /** The drive's local label. */
  label: string | null | undefined;
  /** The folder's drive-relative path, as a folder invite names it. */
  folderPath: string | null | undefined;
  /** What the panel's header calls it. */
  folderName: string;
  /**
   * The card view's narrow name strip: the icon and the count only, the
   * words moving to the tooltip.
   */
  compact?: boolean;
  className?: string;
}) {
  const summary = useOwnedFolderSharingAt(label, folderPath);
  const setShareTarget = useSetAtom(shareDriveModalAtom);
  const sharing = folderRowSharing(summary);
  const pathPrefix = folderSharingKey(folderPath);

  if (!SHARED_DRIVES_ENABLED || !label || !pathPrefix || !sharing.isShared) {
    return null;
  }

  const open = (e: React.MouseEvent | React.KeyboardEvent) => {
    // The row is a link to the folder, and the card opens it on click.
    e.stopPropagation();
    e.preventDefault();
    setShareTarget({ label, folderName, pathPrefix });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") open(e);
  };

  // role=button, not a <button>: both controls sit inside the row's <a>, and
  // a button inside a link is invalid markup. Enter and Space match a button.
  return (
    <span
      className={cn("inline-flex flex-shrink-0 items-center gap-1", className)}
    >
      <span
        role="button"
        tabIndex={0}
        title={sharing.title ?? undefined}
        aria-label={`${sharing.label}. Manage access to this folder`}
        onClick={open}
        onKeyDown={onKeyDown}
        className={cn(
          SHARED_BY_ME_PILL_CLASS,
          compact && "gap-1 px-1.5",
          "cursor-pointer transition-colors hover:bg-[#1F50BD]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-50/40 dark:hover:bg-[#6b93ea]/10",
        )}
      >
        <Users className="size-3" aria-hidden="true" />
        {compact
          ? summary && summary.holderCount > 0
            ? summary.holderCount
            : null
          : sharing.label}
      </span>
      <span
        role="button"
        tabIndex={0}
        title="Manage access"
        aria-label={`Manage access for ${folderName}`}
        onClick={open}
        onKeyDown={onKeyDown}
        className="inline-flex h-5 flex-shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-primary-50 px-1 text-[11px] font-medium text-primary-50 transition-colors hover:bg-primary-50/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-50/40 dark:border-primary-brand-dark dark:text-primary-brand-dark dark:hover:bg-primary-50/15"
      >
        <UserCog
          className={cn("size-3", !compact && "@[22rem]:hidden")}
          aria-hidden="true"
        />
        {compact ? null : (
          <span className="hidden px-0.5 @[22rem]:inline">Manage access</span>
        )}
      </span>
    </span>
  );
}

/**
 * The same mark beside the breadcrumb of an open folder that is shared on its
 * own, with the way in to its Manage access, as the drive header does for a
 * shared drive. Nothing on a folder that is not itself shared: a folder inside
 * a shared one is covered by its parent's mark, one level up.
 */
export function FolderSharingHeaderMark({
  label,
  folderPath,
}: {
  label: string | null | undefined;
  /** The open folder's drive-relative path. */
  folderPath: string | null | undefined;
}) {
  const summary = useOwnedFolderSharingAt(label, folderPath);
  const setShareTarget = useSetAtom(shareDriveModalAtom);
  const sharing = folderRowSharing(summary);
  const pathPrefix = folderSharingKey(folderPath);

  if (!SHARED_DRIVES_ENABLED || !label || !pathPrefix || !sharing.isShared) {
    return null;
  }
  const folderName = pathPrefix.split("/").pop() || pathPrefix;

  return (
    <div className="flex min-w-0 items-center gap-2">
      <span
        title={sharing.title ?? undefined}
        className={SHARED_BY_ME_PILL_CLASS}
      >
        <Users className="size-3" aria-hidden="true" />
        {sharing.label}
      </span>
      <Button
        variant="ghost"
        size="auto"
        onClick={() => setShareTarget({ label, folderName, pathPrefix })}
        className="h-7 flex-shrink-0 rounded-md border border-primary-50 px-2.5 text-xs font-medium text-primary-50 transition-colors hover:bg-primary-50/10 dark:border-primary-brand-dark dark:text-primary-brand-dark dark:hover:bg-primary-50/15"
      >
        Manage access
      </Button>
    </div>
  );
}
