"use client";

import React from "react";

import {
  driveRoleDescription,
  driveRoleLabel,
  type DriveRole,
} from "@/app/lib/shared-drives/roles";
import { cn } from "@/lib/utils";

/**
 * What the viewer may do in a drive somebody else owns.
 *
 * Ported from the console's `files-table/DriveRoleChip.tsx`, tones and
 * geometry included, for the two roles this client has. Two clients colouring
 * the same role differently is a worse fault than either palette being wrong,
 * so a change to Viewer or Editor has to land on both sides together.
 *
 * Colour carries the same ordering the roles themselves have, so a list of
 * drives can be read for access at a glance instead of word by word:
 *
 *   Editor:  blue, the console's own colour for "you can act here".
 *   Viewer:  neutral, because read-only is the absence of power and a
 *            colour would be claiming something it does not have.
 *
 * Editor is deliberately NOT amber. Amber is already spoken for by the
 * frozen/warning treatments, and two amber pills side by side read as one
 * state split in two. Amber also says "caution" about a role that is
 * perfectly ordinary.
 *
 * Every tone is written for both themes, because the drive list is read in
 * each. Light uses the flat -90 fill the rest of the app's chips use; dark
 * uses an alpha wash of the mid tone, since those flat fills are mixed for
 * white and go muddy on near-black.
 */
const ROLE_TONES: Record<DriveRole, string> = {
  writer: cn(
    "border-primary-80 bg-primary-90 text-primary-50",
    "dark:border-primary-40 dark:bg-primary-50/15 dark:text-primary-65",
  ),
  reader: cn(
    "border-grey-dark-100 bg-grey-light-700 text-grey-30",
    "dark:border-black-300 dark:bg-black-300 dark:text-grey-dark-200",
  ),
};

export default function DriveRoleChip({
  role,
  className,
}: {
  role: DriveRole;
  className?: string;
}) {
  return (
    <span
      // The word says what the role is called, not what it lets you do.
      // Hovering answers the second question, rather than a legend nobody
      // reads.
      title={driveRoleDescription(role)}
      className={cn(
        "inline-flex h-[20px] shrink-0 items-center rounded-full border px-1.5 text-[10px] font-semibold uppercase leading-none tracking-[0.04em]",
        ROLE_TONES[role],
        className,
      )}
    >
      {driveRoleLabel(role)}
    </span>
  );
}
