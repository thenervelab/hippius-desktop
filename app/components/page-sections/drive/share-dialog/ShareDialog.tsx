"use client";

// The Share dialog, for a drive or one folder in it. Top to bottom:
//
//   1. Invite people: an EMAIL invite (`email_drive_invite`), Viewer or
//      Editor, single use, bound to the recipient.
//   2. People with access: the owner, members (with a working role select)
//      or folder holders, and emailed invitations still waiting, from one
//      Rust fold (`list_share_access`). "Manage access" opens the panel.
//   3. General access: a LINK invite (`create_drive_invite`, or
//      `create_folder_invite` for a folder), usable by whoever holds it.
//
// Only the owner and a whole-drive Manager add people (Rust's `canManage`);
// anyone else sees People with access alone, read only.
//
// On a plan without sharing (Free, Starter; Rust decides, `canShareDrives`)
// the dialog still opens, so the owner can see who has access and remove
// people: the Invite and General access sections give way to one upgrade
// card, and a 403 `shared_drives_not_entitled` from any command does the
// same. While the plan loads, skeletons stand where those sections go.
//
// Invite and link are separate controls with separate commands: a typed
// address can never turn a link into an email invite, or the reverse. The
// dialog stays open after each, so several people can be invited in one go;
// Done closes it.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui";
import { FramedDialog } from "@/components/ui/FramedDialog";
import { FOLDER_ROLES_ENABLED, SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import {
  driveInvitesVersionAtom,
  inviteKeyDeliveredVersionAtom,
  shareDialogAtom,
  shareDriveModalAtom,
  type ShareDriveModalTarget,
} from "@/app/lib/global-atoms/sharesAtoms";
import { useSharedDrivesInPlan } from "@/app/lib/hooks/useSharedDrivesInPlan";
import { invalidateOwnedDriveSharing } from "@/app/lib/hooks/useOwnedDriveSharing";
import { useSharedDriveMemberships } from "@/app/lib/hooks/useSharedDriveRoles";
import { inviteDriveDisplayName } from "@/app/lib/shared-drives/inviteDriveName";
import { parseSharedDriveLabel } from "@/app/lib/shared-drives/sharedDriveLabel";
import type { DriveMembershipInfo } from "@/app/lib/tauri/sharedDrives";
import { BILLING_ROUTE } from "@/app/lib/routes";
import { InvitePeopleSection } from "./InvitePeopleSection";
import { PeopleWithAccessSection } from "./PeopleWithAccessSection";
import { GeneralAccessSection } from "./GeneralAccessSection";
import { NotEntitledNotice, SharingActionsSkeleton } from "./SectionNoticeView";
import { useShareAccess } from "./useShareAccess";
import { peopleHaveAccess, sharingGate } from "./shareDialogState";
import { canManageDrive, parseDriveRole } from "@/app/lib/shared-drives/roles";

const DIVIDER = <hr className="my-5 border-grey-80 dark:border-white/10" />;

export default function ShareDialog() {
  const [target, setTarget] = useAtom(shareDialogAtom);
  const close = useCallback(() => setTarget(null), [setTarget]);
  if (!SHARED_DRIVES_ENABLED || !target) return null;
  // Remount for each target so nothing from the previous drive (a typed
  // address, a finished link, a message, a loaded list) carries over.
  const key = `${target.label}|${target.pathPrefix ?? "\u0000"}|${target.ownerSs58 ?? ""}`;
  return <ShareDialogBody key={key} target={target} close={close} />;
}

function ShareDialogBody({ target, close }: { target: ShareDriveModalTarget; close: () => void }) {
  const bumpInvites = useSetAtom(driveInvitesVersionAtom);
  const openManagePanel = useSetAtom(shareDriveModalAtom);
  const queryClient = useQueryClient();
  const router = useRouter();
  const planIncludesSharing = useSharedDrivesInPlan();
  const memberships = useSharedDriveMemberships();

  const driveTarget = useMemo(
    () =>
      target.ownerSs58 && target.folderHash
        ? { ownerSs58: target.ownerSs58, folderHash: target.folderHash }
        : undefined,
    [target.ownerSs58, target.folderHash],
  );

  // A FOLDER is decided by the key being present, never by its value: an
  // empty folder path goes to the folder command (which refuses it) rather
  // than quietly turning into a whole-drive invite.
  const pathPrefix = target.pathPrefix !== undefined ? target.pathPrefix.trim() : null;
  const folder = pathPrefix !== null;
  // Without folder collaboration a folder is shared view only, by link only,
  // exactly as before; with it, email and Editor are offered too.
  const folderRoles = folder && FOLDER_ROLES_ENABLED;
  const emailOffered = !folder || folderRoles;
  const membership = findMembership(target, memberships);
  const [refusedByServer, setRefusedByServer] = useState(false);
  const onNotEntitled = useCallback(() => setRefusedByServer(true), []);
  // Always loaded: on a plan without sharing the owner still sees who has
  // access and can remove them.
  const access = useShareAccess({
    label: target.label,
    pathPrefix,
    target: driveTarget,
  });

  // Who may add people here: the owner, or a whole-drive Manager. Rust's
  // `canManage` decides once the list is in; until then the membership says.
  // A Viewer or an Editor sees who has access and nothing to add with.
  const canManage =
    access.state.kind === "ready"
      ? access.state.access.canManage
      : canManageDrive({
          isOwner: !membership,
          role: membership ? parseDriveRole(membership.role) : undefined,
        });
  // The plan asked about is this account's, so it only gates a drive this
  // account owns. On a drive it manages the owner's plan decides, and only a
  // 403 from the server shows the upgrade card there.
  const planGate = sharingGate({
    planAllows: planIncludesSharing,
    owner: !membership,
    refusedByServer,
  });
  const gate = canManage ? planGate : "none";

  // Every change reports here: the drive list's badge and an open Links tab
  // pick it up without a reopen, and the people list reloads in place.
  const { reload, retry } = access;
  const onChanged = useCallback(() => {
    void invalidateOwnedDriveSharing(queryClient);
    bumpInvites((n) => n + 1);
  }, [queryClient, bumpInvites]);
  const onSent = useCallback(() => {
    onChanged();
    void reload();
  }, [onChanged, reload]);

  // Rust delivered an emailed invitation's key on its own: read the people
  // list again so the row moves from "Opened" to "Approved" in place.
  const delivered = useAtomValue(inviteKeyDeliveredVersionAtom);
  const seenDelivered = useRef(delivered);
  useEffect(() => {
    if (seenDelivered.current === delivered) return;
    seenDelivered.current = delivered;
    void reload();
  }, [delivered, reload]);

  // The in-app plans page, like every other Drive upgrade prompt.
  const upgrade = useCallback(() => {
    close();
    router.push(BILLING_ROUTE);
  }, [close, router]);

  const driveName = driveDisplayName(target, membership);
  const folderPath = pathPrefix?.replace(/^\/+|\/+$/g, "") ?? null;
  const name = folder ? folderPath || target.folderName || "this folder" : driveName;

  // Manage access opens the panel for what this dialog shares: the drive, or
  // this folder (its holders, invitations and links). The panel and this
  // dialog are two surfaces for one thing, so this one closes as it opens.
  const manage = useCallback((openOn?: "people") => {
    close();
    openManagePanel({
      label: target.label,
      folderName: driveName,
      ownerSs58: target.ownerSs58,
      folderHash: target.folderHash,
      ...(pathPrefix !== null ? { pathPrefix } : {}),
      ...(openOn ? { openOn } : {}),
    });
  }, [close, openManagePanel, target.label, target.ownerSs58, target.folderHash, driveName, pathPrefix]);

  const subtitle = folder
    ? `${folderPath || name} in ${driveName}`
    : access.state.kind === "ready"
      ? `Drive · ${peopleHaveAccess(1 + access.state.access.members.length)}`
      : "Drive";

  return (
    <FramedDialog
      open
      onClose={close}
      headerLayout="leading"
      title={<span title={name}>Share “{name}”</span>}
      subtitle={
        <span className="block truncate" title={subtitle}>
          {subtitle}
        </span>
      }
      maxWidth="max-w-[720px]"
      contentClassName="min-w-0 sm:px-6 sm:pt-5"
    >
      <div className="font-geist">
        {gate === "upgrade" ? (
          <>
            <NotEntitledNotice onUpgrade={upgrade} />
            {DIVIDER}
          </>
        ) : gate === "loading" ? (
          emailOffered ? (
            <>
              <SharingActionsSkeleton />
              {DIVIDER}
            </>
          ) : null
        ) : gate === "allowed" && emailOffered ? (
          <>
            <InvitePeopleSection
              label={target.label}
              pathPrefix={pathPrefix}
              target={driveTarget}
              onSent={onSent}
              onUpgrade={upgrade}
              onNotEntitled={onNotEntitled}
            />
            {DIVIDER}
          </>
        ) : null}
        <PeopleWithAccessSection
          state={access.state}
          folder={folderPath}
          label={target.label}
          target={driveTarget}
          ownerName={membership?.ownerName}
          reload={reload}
          retry={retry}
          onChanged={onChanged}
          onManage={manage}
          canAddAccess={gate === "allowed"}
          onNotEntitled={onNotEntitled}
        />
        {gate === "allowed" ? (
          <>
            {DIVIDER}
            <GeneralAccessSection
              label={target.label}
              pathPrefix={pathPrefix}
              folderRoles={folderRoles}
              target={driveTarget}
              onCreated={onChanged}
              onUpgrade={upgrade}
              onNotEntitled={onNotEntitled}
            />
          </>
        ) : gate === "loading" ? (
          <>
            {DIVIDER}
            <SharingActionsSkeleton />
          </>
        ) : null}

        <div className="mt-6 flex justify-end">
          <Button
            type="button"
            variant="primary"
            size="auto"
            onClick={close}
            className="h-[38px] w-full rounded-[8px] px-6 text-sm font-medium sm:w-auto sm:min-w-[96px]"
          >
            Done
          </Button>
        </div>
      </div>
    </FramedDialog>
  );
}

/** The membership this dialog's drive is, when it is somebody else's. */
export function findMembership(
  target: ShareDriveModalTarget,
  memberships: readonly DriveMembershipInfo[],
): DriveMembershipInfo | undefined {
  const identity =
    parseSharedDriveLabel(target.label) ??
    (target.ownerSs58 && target.folderHash
      ? { ownerSs58: target.ownerSs58, folderHash: target.folderHash }
      : null);
  if (identity) {
    return memberships.find(
      (m) => m.ownerSs58 === identity.ownerSs58 && m.folderHash === identity.folderHash,
    );
  }
  return memberships.find((m) => m.localLabel === target.label);
}

/**
 * The drive's human name. A `shared:…` browse label is a wire id, never a
 * title. For a folder target `folderName` is the FOLDER, so only the label
 * and the membership can name the drive.
 */
export function driveDisplayName(
  target: ShareDriveModalTarget,
  membership: DriveMembershipInfo | undefined,
): string {
  const folder = target.pathPrefix !== undefined;
  const preferred = inviteDriveDisplayName(folder ? undefined : target.folderName, target.label);
  if (preferred !== "this drive") return preferred;
  return inviteDriveDisplayName(membership?.displayLabel, target.label);
}
