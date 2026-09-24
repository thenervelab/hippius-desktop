// The Manage access side panel, for a drive or one folder of it. Opened via
// `shareDriveModalAtom` (the `ShareFileModal` singleton pattern: mounted once
// in the pages layout, any surface opens it by setting the atom).
//
// One scrolling list, grouped:
//
//   People             the owner, you, members (role select, Remove) and
//                      folder holders tagged with their folder (Change
//                      folders, Remove). Read only for anyone but the owner.
//   Pending invites    emailed invitations still waiting (Cancel, Approve).
//   Links              working links with usage, expiry, maker and the link
//                      itself; ended ones folded into one line.
//
// Everything in it comes from one Rust fold (`list_access_panel`); every
// change is pessimistic, like the Share dialog's rows, which it reuses.
// Inviting and making links happen in the Share dialog (`shareDialogAtom`);
// the panel opens it and steps aside.

"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import * as Dialog from "@radix-ui/react-dialog";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { Folder, HardDrive, LogOut, X } from "lucide-react";
import { toast } from "sonner";

import { Button, Icons } from "@/components/ui";
import ConfirmationDialog from "@/components/ConfirmationDialog";
import { useBreakpoint } from "@/app/lib/hooks";
import { invalidateOwnedDriveSharing } from "@/app/lib/hooks/useOwnedDriveSharing";
import {
  MY_FOLDER_GRANTS_QUERY_KEY,
  SHARED_DRIVE_MEMBERSHIPS_QUERY_KEY,
  useSharedDriveMemberships,
} from "@/app/lib/hooks/useSharedDriveRoles";
import { useStorageOverview } from "@/app/lib/hooks/api/useStorageOverview";
import { useUnlockFlow } from "@/app/lib/hooks/useUnlockFlow";
import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import {
  driveInvitesVersionAtom,
  shareDialogAtom,
  shareDriveModalAtom,
  type ShareDriveModalTarget,
} from "@/app/lib/global-atoms/sharesAtoms";
import { activeRecoveryCheckAtom } from "@/app/lib/global-atoms/recoveryAtoms";
import { triggerSyncPathRefreshAtom } from "@/app/lib/global-atoms/unpinAtoms";
import {
  leaveSharedDrive,
  leaveSharedDriveByIdentity,
  type AccessPanel,
  type DriveMembershipInfo,
} from "@/app/lib/tauri/sharedDrives";
import { parseFolderGrantLabel, parseSharedDriveLabel } from "@/app/lib/shared-drives/sharedDriveLabel";
import { accountDisplayName } from "@/app/lib/shared-drives/accountLabel";
import { frozenNotice } from "@/app/lib/shared-drives/writeRefusal";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { cn } from "@/lib/utils";

import { InlineNotice } from "./share-dialog/InlineNotice";
import {
  MemberRow,
  OwnerRow,
  PendingRow,
  useRowChanges,
} from "./share-dialog/PeopleWithAccessSection";
import { shareAccessApiFor, type ShareAccessApi } from "./share-dialog/shareAccessApi";
import { useReloadOnShareDevToolsChange } from "./share-dialog/shareDevToolsSettings";
import { FOLDER_ACCESS_HINT, SHARED_DRIVES_UNAVAILABLE_COPY } from "./share-dialog/shareDialogState";
import { driveDisplayName, findMembership } from "./share-dialog/ShareDialog";
import { useAccessPanel, type AccessPanelState } from "./access-panel/useAccessPanel";
import {
  EmptyAccess,
  EndedLinks,
  FolderTag,
  GroupHeader,
  HolderRow,
  LinkRow,
  PanelSkeleton,
  ShowAllRows,
} from "./access-panel/AccessPanelRows";
import type { FolderRole } from "./access-panel/ChangeFoldersDialog";
import {
  ACCESS_PANEL_COPY,
  PANEL_GROUP_CAP,
  capRows,
  isOnlyOwner,
  memberMeta,
  panelSubline,
  peopleCount,
  pendingLeft,
  pendingStage,
  planLabel,
} from "./access-panel/accessPanelView";
import { driveRoleLabel, parseDriveRole } from "@/app/lib/shared-drives/roles";

/** Wider than File Details' 305: this panel holds lists, not labels. */
const PANEL_WIDTH_PX = 360;

export default function ShareDrivePanel() {
  const [target, setTarget] = useAtom(shareDriveModalAtom);
  const { isDesktop, isLargeDesktop } = useBreakpoint();
  const onClose = useCallback(() => setTarget(null), [setTarget]);
  const open = Boolean(SHARED_DRIVES_ENABLED && target);

  // Remount for each target so nothing from the previous drive or folder (a
  // loaded list, an open menu, a row error) carries over.
  const body = target ? (
    <AccessPanelBody
      key={`${target.label}|${target.pathPrefix ?? "\u0000"}|${target.ownerSs58 ?? ""}`}
      target={target}
      onClose={onClose}
    />
  ) : null;

  // Same shell as File Details: an inline width-slide on large screens so the
  // drive list stays visible beside it -- managing access is something you do
  // WHILE looking at your drives -- and a slide-in overlay below that, where
  // there is no room for both.
  if (isDesktop || isLargeDesktop) {
    return (
      <AnimatePresence initial={false}>
        {open && (
          <motion.aside
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: PANEL_WIDTH_PX, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="h-full shrink-0 overflow-hidden"
          >
            <div className="flex h-full min-h-0 flex-col overflow-hidden" style={{ width: PANEL_WIDTH_PX }}>
              {body}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[1002] bg-white/72 backdrop-blur-[5.75px] dark:bg-[rgba(4,4,4,0.4)] dark:backdrop-blur-[11.5px] animate-fade-in-0.2" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed bottom-0 right-0 top-0 z-[1003] flex w-full max-w-[360px] flex-col overflow-hidden bg-cover bg-fixed bg-center bg-no-repeat font-geist animate-panel-in bg-[url('/logged-in-app-background.png')] dark:bg-[url('/logged-in-app-background-dark.png')]"
        >
          <Dialog.Title className="sr-only">Manage access</Dialog.Title>
          {body}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The drive's wire identity, from whatever the target and listings know. */
function wireIdentity(
  target: ShareDriveModalTarget,
  membership: DriveMembershipInfo | undefined,
): { ownerSs58: string; folderHash: string } | null {
  const fromLabel = parseSharedDriveLabel(target.label) ?? parseFolderGrantLabel(target.label);
  if (fromLabel) return { ownerSs58: fromLabel.ownerSs58, folderHash: fromLabel.folderHash };
  if (target.ownerSs58 && target.folderHash) return { ownerSs58: target.ownerSs58, folderHash: target.folderHash };
  if (membership) return { ownerSs58: membership.ownerSs58, folderHash: membership.folderHash };
  return null;
}

function AccessPanelBody({ target, onClose }: { target: ShareDriveModalTarget; onClose: () => void }) {
  const queryClient = useQueryClient();
  const setShareDialogTarget = useSetAtom(shareDialogAtom);
  const refreshSyncPaths = useSetAtom(triggerSyncPathRefreshAtom);
  const memberships = useSharedDriveMemberships();
  const { data: overview } = useStorageOverview();

  // A folder is decided by the key being present, as in the Share dialog.
  const pathPrefix = target.pathPrefix !== undefined ? target.pathPrefix.trim() : null;
  const folder = pathPrefix !== null;
  const folderPath = pathPrefix?.replace(/^\/+|\/+$/g, "") ?? null;
  const driveTarget = useMemo(
    () =>
      target.ownerSs58 && target.folderHash
        ? { ownerSs58: target.ownerSs58, folderHash: target.folderHash }
        : undefined,
    [target.ownerSs58, target.folderHash],
  );

  // Real commands, or (dev and staging only) the Share dev tools' fake data,
  // which the API decides per call; the list starts over when those change.
  const [api] = useState<ShareAccessApi>(() => shareAccessApiFor(folder));
  const { state, reload, retry } = useAccessPanel({ api, label: target.label, pathPrefix, target: driveTarget });
  useReloadOnShareDevToolsChange(retry);

  // The Share dialog bumps this on every invite or link it makes.
  const invitesVersion = useAtomValue(driveInvitesVersionAtom);
  const seenVersion = useRef(invitesVersion);
  useEffect(() => {
    if (seenVersion.current === invitesVersion) return;
    seenVersion.current = invitesVersion;
    void reload();
  }, [invitesVersion, reload]);

  // Locked links: the unlock flow runs in its own dialog, and once it closes
  // the listing is read again, which opens the links that can now be opened.
  const { unlock, busy: unlocking } = useUnlockFlow();
  const recoveryCheck = useAtomValue(activeRecoveryCheckAtom);
  const hadRecovery = useRef(false);
  useEffect(() => {
    if (recoveryCheck) {
      hadRecovery.current = true;
    } else if (hadRecovery.current) {
      hadRecovery.current = false;
      void reload();
    }
  }, [recoveryCheck, reload]);

  const membership = findMembership(target, memberships);
  const driveName = driveDisplayName({ ...target, pathPrefix: undefined }, membership);
  const title = folder ? folderPath || "this folder" : driveName;

  const onChanged = useCallback(() => {
    void invalidateOwnedDriveSharing(queryClient);
  }, [queryClient]);
  const { busy, rowError, run } = useRowChanges(onChanged, reload);

  const openShareDialog = useCallback(() => {
    // Close the panel as the dialog opens: they are two surfaces for one
    // drive, and on a small screen the panel sits above the dialog's layer.
    onClose();
    setShareDialogTarget(
      folder
        ? {
            label: target.label,
            folderName: folderPath ?? "",
            ownerSs58: target.ownerSs58,
            folderHash: target.folderHash,
            pathPrefix: pathPrefix ?? "",
          }
        : {
            label: target.label,
            folderName: target.folderName,
            ownerSs58: target.ownerSs58,
            folderHash: target.folderHash,
          },
    );
  }, [onClose, setShareDialogTarget, folder, folderPath, pathPrefix, target]);

  const panel = state.kind === "ready" ? state.panel : null;
  // Before the listing lands, whether links will show is a guess: only the
  // owner manages, and a drive with no membership row is this account's own.
  const expectManage = !membership;
  const ownerName =
    membership?.ownerName?.trim() || (panel ? accountDisplayName(panel.ownerSs58) : "the owner");
  const subline = panel
    ? panelSubline({
        folder,
        ownerIsYou: panel.ownerIsYou,
        driveName,
        ownerName,
        yourRole: panel.yourRole,
        planName: planLabel(overview?.plan?.name ?? (overview?.source === "free" ? "Free" : null)),
      })
    : null;

  // Leaving is for anyone the drive is shared with.
  const [leaving, setLeaving] = useState<"idle" | "confirm" | "busy">("idle");
  const leave = useCallback(async () => {
    setLeaving("busy");
    try {
      const identity = wireIdentity(target, membership);
      if (membership?.syncedLocally && membership.localLabel) {
        // Ends the membership AND removes the drive from this device.
        await leaveSharedDrive(membership.localLabel);
      } else if (identity) {
        await leaveSharedDriveByIdentity(identity.ownerSs58, identity.folderHash);
      } else {
        await leaveSharedDrive(target.label);
      }
      toast.success(`Left "${title}"`);
      void queryClient.invalidateQueries({ queryKey: [SHARED_DRIVE_MEMBERSHIPS_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [MY_FOLDER_GRANTS_QUERY_KEY] });
      refreshSyncPaths((n) => n + 1);
      onClose();
    } catch (err) {
      toast.error(`Could not leave the ${folder ? "folder" : "drive"}: ${errorMessage(err)}`);
      setLeaving("idle");
    }
  }, [target, membership, title, queryClient, refreshSyncPaths, onClose, folder]);

  const canManage = panel ? panel.canManage : expectManage;
  const sharedWithMe = panel ? !panel.ownerIsYou : Boolean(membership);

  return (
    <div className="@container flex h-full min-h-0 flex-col font-geist">
      <header className="shrink-0 border-b border-grey-80 px-4 pb-3.5 pt-4 dark:border-white/10">
        <div className="flex items-start gap-2.5">
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-primary-50/10 text-primary-50 dark:bg-primary-50/15 dark:text-primary-brand-dark"
          >
            {folder ? <Folder className="size-[18px]" /> : <HardDrive className="size-[18px]" />}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-base font-semibold leading-5 text-grey-10 [overflow-wrap:anywhere] dark:text-white">
              {title}
            </h2>
            <p className="mt-0.5 min-h-[18px] break-words text-xs text-grey-50 dark:text-grey-dark-600">
              {subline ?? <span className="sr-only">Loading</span>}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex size-[30px] shrink-0 items-center justify-center rounded-lg text-grey-50 transition-colors hover:bg-grey-90 hover:text-grey-10 dark:text-grey-dark-600 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <X className="size-4" />
          </button>
        </div>
        {membership?.frozen ? (
          <InlineNotice tone="info" className="mt-3">
            {frozenNotice(membership.frozenUntil)}
          </InlineNotice>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <PanelContent
          state={state}
          folder={folder}
          expectManage={expectManage}
          ownerName={membership?.ownerName}
          retry={retry}
          onShare={openShareDialog}
          busy={busy}
          rowError={rowError}
          locked={Boolean(panel?.linksLocked)}
          unlocking={unlocking}
          onUnlock={() => void unlock()}
          actions={{
            changeRole: (ss58, who, role) =>
              void run(ss58, who, "saving", () => api.changeRole(target.label, ss58, role, driveTarget)),
            remove: (ss58, who) =>
              void run(ss58, who, "removing", () => api.remove(target.label, ss58, driveTarget)),
            revoke: (id, who) => void run(id, who, "revoking", () => api.revoke(target.label, id, driveTarget)),
            cancel: (id, who) => void run(id, who, "removing", () => api.revoke(target.label, id, driveTarget)),
            approve: (id, who) => void run(id, who, "saving", () => api.approve(target.label, id, driveTarget)),
            // Throws on refusal: the dialog shows why and stays open.
            changeFolders: async (ss58, folders, role) => {
              await api.replaceFolders(target.label, ss58, folders, role, driveTarget);
              toast.success("Folders updated");
              onChanged();
              await reload();
            },
          }}
        />
      </div>

      {state.kind === "ready" || state.kind === "loading" ? (
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-grey-80 px-4 py-3 dark:border-white/10">
          {sharedWithMe ? (
            <Button
              type="button"
              variant="defaultStable"
              size="auto"
              disabled={leaving === "busy"}
              onClick={() => setLeaving("confirm")}
              className="h-[38px] gap-1.5 rounded-[8px] px-3.5 text-sm font-medium text-error-70 dark:text-error-70"
            >
              <LogOut className="size-4" aria-hidden />
              {leaving === "busy" ? "Leaving…" : folder ? "Leave folder" : "Leave drive"}
            </Button>
          ) : (
            <span className="hidden text-xs text-grey-50 @[340px]:inline dark:text-grey-dark-600">
              {ACCESS_PANEL_COPY.changesApply}
            </span>
          )}
          {canManage ? (
            <Button
              type="button"
              variant="primary"
              size="auto"
              onClick={openShareDialog}
              className="ml-auto h-[38px] gap-1.5 rounded-[8px] px-4 text-sm font-medium"
            >
              <Icons.Link className="size-4" />
              Share
            </Button>
          ) : null}
        </footer>
      ) : null}

      <ConfirmationDialog
        open={leaving === "confirm"}
        onClose={() => setLeaving("idle")}
        onBack={() => setLeaving("idle")}
        onConfirm={() => void leave()}
        heading={folder ? "Leave shared folder" : "Leave shared drive"}
        icon={<Icons.Trash className="size-4 text-white" />}
        iconBgColor="bg-[#fc7d73]"
        confirmVariant="destructive"
        confirmButtonClassName="text-white"
        button={folder ? "Leave folder" : "Leave drive"}
        text={`Leave "${title}"?`}
        helperText={
          folder
            ? "You lose access to it, and to any other folder of the same drive shared with you. The owner can invite you again."
            : "You lose access to its files. Anything already downloaded to this computer stays, and the owner can invite you again."
        }
      />
    </div>
  );
}

type RowActions = {
  changeRole: (ss58: string, who: string, role: ReturnType<typeof parseDriveRole>) => void;
  remove: (ss58: string, who: string) => void;
  revoke: (inviteId: string, who: string) => void;
  cancel: (inviteId: string, who: string) => void;
  approve: (inviteId: string, who: string) => void;
  changeFolders: (ss58: string, folders: string[], role?: FolderRole) => Promise<void>;
};

function PanelContent({
  state,
  folder,
  expectManage,
  ownerName,
  retry,
  onShare,
  busy,
  rowError,
  locked,
  unlocking,
  onUnlock,
  actions,
}: {
  state: AccessPanelState;
  folder: boolean;
  expectManage: boolean;
  ownerName?: string;
  retry: () => void;
  onShare: () => void;
  busy: Record<string, ReturnType<typeof useRowChanges>["busy"][string]>;
  rowError: { key: string; message: string } | null;
  locked: boolean;
  unlocking: boolean;
  onUnlock: () => void;
  actions: RowActions;
}) {
  // Each group draws its first rows and a "Show all N" for the rest.
  const [allPending, setAllPending] = useState(false);
  const [allLinks, setAllLinks] = useState(false);
  if (state.kind === "loading") return <PanelSkeleton withLinks={expectManage} />;
  if (state.kind === "unavailable") {
    return (
      <InlineNotice tone="info" className="mt-4">
        {SHARED_DRIVES_UNAVAILABLE_COPY}
      </InlineNotice>
    );
  }
  if (state.kind === "error") {
    return (
      <InlineNotice
        tone="error"
        className="mt-4"
        action={
          <Button
            type="button"
            variant="defaultStable"
            size="auto"
            onClick={retry}
            className="h-8 rounded-[6px] px-3 text-xs font-medium"
          >
            Try again
          </Button>
        }
      >
        {state.message}
      </InlineNotice>
    );
  }

  const panel = state.panel;
  const owner = <OwnerRow ss58={panel.ownerSs58} isYou={panel.ownerIsYou} name={ownerName} />;
  if (isOnlyOwner(panel)) {
    return (
      <>
        <GroupHeader id="access-people" title="People" count={1} />
        {owner}
        <EmptyAccess folder={folder} onShare={onShare} />
      </>
    );
  }

  const pending = capRows(panel.pendingInvites, allPending);
  const links = capRows(panel.links, allLinks);
  return (
    <>
      <PeopleGroup panel={panel} folder={folder} owner={owner} onShare={onShare} busy={busy} rowError={rowError} actions={actions} />
      {panel.canManage && panel.pendingInvites.length > 0 ? (
        <section aria-labelledby="access-pending">
          <GroupHeader id="access-pending" title="Pending invites" count={panel.pendingInvites.length} />
          <ul>
            {pending.shown.map((invite) => {
              const who = invite.recipientEmail ?? "this invitation";
              const left = pendingLeft(invite.expiresInSecs);
              return (
                <RowItem key={invite.inviteId} id={invite.inviteId} rowError={rowError}>
                  <PendingRow
                    invite={invite}
                    busy={busy[invite.inviteId]}
                    onCancel={() => actions.cancel(invite.inviteId, who)}
                    onApprove={() => actions.approve(invite.inviteId, who)}
                    meta={
                      <>
                        <StagePill status={invite.emailStatus} />
                        {invite.pathPrefix ? <FolderTag>{invite.pathPrefix}</FolderTag> : null}
                        <span className="min-w-0 truncate">
                          {[driveRoleLabel(parseDriveRole(invite.role)), left].filter(Boolean).join(" · ")}
                        </span>
                      </>
                    }
                  />
                </RowItem>
              );
            })}
          </ul>
          {pending.hidden > 0 ? (
            <ShowAllRows total={panel.pendingInvites.length} onClick={() => setAllPending(true)} />
          ) : null}
        </section>
      ) : null}
      {panel.canManage ? (
        <section aria-labelledby="access-links">
          <GroupHeader
            id="access-links"
            title="Links"
            count={`${panel.links.length} active`}
            action={{ label: "New link", onClick: onShare }}
          />
          {locked ? (
            <InlineNotice tone="info" className="mb-1">
              {ACCESS_PANEL_COPY.linksLocked}
            </InlineNotice>
          ) : null}
          <ul>
            {links.shown.map((link) => (
              <RowItem key={link.inviteId} id={link.inviteId} rowError={rowError}>
                <LinkRow
                  link={link}
                  busy={busy[link.inviteId]}
                  locked={locked}
                  unlocking={unlocking}
                  onUnlock={onUnlock}
                  onRevoke={() => actions.revoke(link.inviteId, "this link")}
                />
              </RowItem>
            ))}
          </ul>
          {links.hidden > 0 ? <ShowAllRows total={panel.links.length} onClick={() => setAllLinks(true)} /> : null}
          <EndedLinks links={panel.inactiveLinks} />
        </section>
      ) : null}
    </>
  );
}

function PeopleGroup({
  panel,
  folder,
  owner,
  onShare,
  busy,
  rowError,
  actions,
}: {
  panel: AccessPanel;
  folder: boolean;
  owner: React.ReactNode;
  onShare: () => void;
  busy: Record<string, ReturnType<typeof useRowChanges>["busy"][string]>;
  rowError: { key: string; message: string } | null;
  actions: RowActions;
}) {
  const [all, setAll] = useState(false);
  // Members and folder holders share one cap, and a few holders always make
  // it in so a long member list does not hide every folder tag. The owner is
  // always drawn.
  const holderQuota = Math.min(panel.folderHolders.length, Math.max(5, PANEL_GROUP_CAP - panel.members.length));
  const members = capRows(panel.members, all, PANEL_GROUP_CAP - holderQuota);
  const holders = capRows(panel.folderHolders, all, holderQuota);
  const hidden = members.hidden + holders.hidden;
  return (
    <section aria-labelledby="access-people">
      <GroupHeader
        id="access-people"
        title="People"
        count={peopleCount(panel)}
        action={panel.canManage ? { label: "Invite", onClick: onShare } : undefined}
      />
      <ul>
        <li>{owner}</li>
        {members.shown.map((m) => {
          const who = accountDisplayName(m.memberSs58, m.memberName);
          return (
            <RowItem key={m.memberSs58} id={m.memberSs58} rowError={rowError}>
              <MemberRow
                member={m}
                busy={busy[m.memberSs58]}
                readOnly={!panel.canManage}
                meta={memberMeta(m, folder)}
                onChangeRole={(role) => actions.changeRole(m.memberSs58, who, role)}
                onRemove={() => actions.remove(m.memberSs58, who)}
              />
            </RowItem>
          );
        })}
        {holders.shown.map((h) => {
          const who = accountDisplayName(h.memberSs58, h.memberName);
          return (
            <RowItem key={`holder:${h.memberSs58}`} id={h.memberSs58} rowError={rowError}>
              <HolderRow
                holder={h}
                busy={busy[h.memberSs58]}
                canManage={panel.canManage}
                onRemove={() => actions.remove(h.memberSs58, who)}
                onChangeFolders={(next, role) => actions.changeFolders(h.memberSs58, next, role)}
              />
            </RowItem>
          );
        })}
      </ul>
      {hidden > 0 ? <ShowAllRows total={peopleCount(panel)} onClick={() => setAll(true)} /> : null}
      {/* There is no role change for a folder holder (HCFS #475), so the
          list says what to do instead of offering a control the server
          would refuse. */}
      {panel.canManage && folder && panel.folderHolders.length > 0 ? (
        <p className="mt-1 px-0.5 text-xs text-grey-50 dark:text-grey-dark-600">{FOLDER_ACCESS_HINT}</p>
      ) : null}
    </section>
  );
}

/** A list row with its refusal, if its last change was refused, under it. */
function RowItem({
  id,
  rowError,
  children,
}: {
  id: string;
  rowError: { key: string; message: string } | null;
  children: React.ReactNode;
}) {
  return (
    <li>
      {children}
      {rowError?.key === id ? (
        <InlineNotice tone="error" className="mb-2">
          {rowError.message}
        </InlineNotice>
      ) : null}
    </li>
  );
}

/** How far an emailed invitation has got, as a small pill. */
function StagePill({ status }: { status?: string }) {
  const needsApproval = status === "awaiting_seal";
  const approved = status === "sealed";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-1.5 text-[11px] font-semibold leading-[18px]",
        needsApproval
          ? "bg-warning-50/15 text-warning-50"
          : approved
            ? "bg-success-100 text-success-40 dark:bg-success-50/15 dark:text-success-50"
            : "bg-primary-50/10 text-primary-50 dark:bg-primary-50/15 dark:text-primary-brand-dark",
      )}
    >
      {pendingStage(status)}
    </span>
  );
}
