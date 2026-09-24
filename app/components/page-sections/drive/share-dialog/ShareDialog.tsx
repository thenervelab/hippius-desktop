"use client";

// The Share dialog, for a drive or one folder in it.
//
// Two different server actions, kept visibly apart because they are
// independent on the server and people read a single mixed form as one:
//
//   1. Invite people: an EMAIL invite (`email_drive_invite`), Viewer or
//      Editor, single use, bound to the recipient.
//   2. Share a link: a LINK invite (`create_drive_invite`, or
//      `create_folder_invite` for a folder), usable by whoever holds it.
//
// Each section has its own button, its own result and its own inline
// messages, and neither can call the other's command. The dialog stays open
// after either, so several people can be invited in one go; Done closes it.

import React, { useCallback, useMemo } from "react";
import { useAtom, useSetAtom } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

import { Button, Icons } from "@/components/ui";
import { FramedDialog } from "@/components/ui/FramedDialog";
import { FOLDER_ROLES_ENABLED, SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import {
  driveInvitesVersionAtom,
  shareDialogAtom,
} from "@/app/lib/global-atoms/sharesAtoms";
import { useSharedDrivesInPlan } from "@/app/lib/hooks/useSharedDrivesInPlan";
import { invalidateOwnedDriveSharing } from "@/app/lib/hooks/useOwnedDriveSharing";
import { useSharedDriveMemberships } from "@/app/lib/hooks/useSharedDriveRoles";
import { inviteDriveDisplayName } from "@/app/lib/shared-drives/inviteDriveName";
import { parseSharedDriveLabel } from "@/app/lib/shared-drives/sharedDriveLabel";
import { BILLING_ROUTE } from "@/app/lib/routes";
import { InvitePeopleSection } from "./InvitePeopleSection";
import { ShareLinkSection } from "./ShareLinkSection";
import { NotEntitledNotice } from "./SectionNoticeView";

export default function ShareDialog() {
  const [target, setTarget] = useAtom(shareDialogAtom);
  const bumpInvites = useSetAtom(driveInvitesVersionAtom);
  const queryClient = useQueryClient();
  const router = useRouter();
  const planIncludesSharing = useSharedDrivesInPlan();
  const memberships = useSharedDriveMemberships();

  const close = useCallback(() => setTarget(null), [setTarget]);

  const driveTarget = useMemo(
    () =>
      target?.ownerSs58 && target?.folderHash
        ? { ownerSs58: target.ownerSs58, folderHash: target.folderHash }
        : undefined,
    [target?.ownerSs58, target?.folderHash],
  );

  // Both sections report here: the drive list's badge and an open Links tab
  // pick the new invite up without a reopen.
  const onShared = useCallback(() => {
    void invalidateOwnedDriveSharing(queryClient);
    bumpInvites((n) => n + 1);
  }, [queryClient, bumpInvites]);

  // The in-app plans page, like every other Drive upgrade prompt.
  const upgrade = useCallback(() => {
    close();
    router.push(BILLING_ROUTE);
  }, [close, router]);

  if (!SHARED_DRIVES_ENABLED || !target) return null;

  // A FOLDER is decided by the key being present, never by its value: an
  // empty folder path goes to the folder command (which refuses it) rather
  // than quietly turning into a whole-drive invite.
  const pathPrefix = target.pathPrefix !== undefined ? target.pathPrefix.trim() : null;
  const folder = pathPrefix !== null;
  // Without folder collaboration a folder is shared view only, by link only,
  // exactly as before; with it, email and Editor are offered too.
  const folderRoles = folder && FOLDER_ROLES_ENABLED;
  const emailOffered = !folder || folderRoles;

  const name = folder
    ? pathPrefix || target.folderName || "this folder"
    : driveDisplayName(target, memberships);

  // Remount the sections for each target so nothing from the previous drive
  // (a typed address, a finished link, a message) carries over.
  const sectionKey = `${target.label}|${pathPrefix ?? ""}|${target.ownerSs58 ?? ""}`;

  return (
    <FramedDialog
      open
      onClose={close}
      title={
        <span className="mx-auto block w-full min-w-0 max-w-full truncate px-6" title={name}>
          Share “{name}”
        </span>
      }
      titleClassName="w-full min-w-0 overflow-hidden"
      icon={<Icons.Link className="size-4 text-white" />}
      maxWidth="max-w-[640px]"
      contentClassName="min-w-0 overflow-hidden sm:max-w-[520px]"
    >
      <div className="mt-4 font-geist" key={sectionKey}>
        {planIncludesSharing === false ? (
          // A plan without sharing opens straight into the upgrade prompt
          // rather than a form the server would refuse. The surface is not
          // hidden from them: this is where they learn it exists.
          <NotEntitledNotice onUpgrade={upgrade} />
        ) : (
          <>
            {emailOffered ? (
              <>
                <InvitePeopleSection
                  label={target.label}
                  pathPrefix={pathPrefix}
                  target={driveTarget}
                  onSent={onShared}
                  onUpgrade={upgrade}
                />
                <hr className="my-5 border-grey-80 dark:border-white/10" />
              </>
            ) : null}
            <ShareLinkSection
              label={target.label}
              pathPrefix={pathPrefix}
              folderRoles={folderRoles}
              target={driveTarget}
              onCreated={onShared}
              onUpgrade={upgrade}
            />
          </>
        )}

        <div className="mt-6 flex justify-end">
          <Button
            type="button"
            variant="defaultStable"
            size="auto"
            onClick={close}
            className="h-[38px] w-full rounded-[8px] px-6 text-sm font-medium sm:w-auto"
          >
            Done
          </Button>
        </div>
      </div>
    </FramedDialog>
  );
}

/**
 * The drive's human name. A `shared:…` browse label is a wire id, never a
 * title: resolve it from memberships, else say "this drive".
 */
function driveDisplayName(
  target: { label: string; folderName: string; ownerSs58?: string; folderHash?: string },
  memberships: ReadonlyArray<{ ownerSs58: string; folderHash: string; displayLabel: string }>,
): string {
  const preferred = inviteDriveDisplayName(target.folderName, target.label);
  if (preferred !== "this drive") return preferred;
  const identity =
    parseSharedDriveLabel(target.label) ??
    parseSharedDriveLabel(target.folderName) ??
    (target.ownerSs58 && target.folderHash
      ? { ownerSs58: target.ownerSs58, folderHash: target.folderHash }
      : null);
  if (!identity) return preferred;
  const match = memberships.find(
    (m) => m.ownerSs58 === identity.ownerSs58 && m.folderHash === identity.folderHash,
  );
  return inviteDriveDisplayName(match?.displayLabel, target.label);
}
