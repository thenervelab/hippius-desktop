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
// A big drive has 100 people and 100 links, so the main view draws only each
// group's first rows, with a jump bar above the list and "Show all N …"
// under a group; the full list of one group opens in place of the main one,
// with search, filter chips and a windowed list (`access-panel/AccessPanelViews`).
//
// Everything in it comes from one Rust fold (`list_access_panel`); every
// change is pessimistic, like the Share dialog's rows, which it reuses.
// Inviting and making links happen in the Share dialog (`shareDialogAtom`);
// the panel opens it and steps aside.
//
// Nothing opens a second dialog over the panel (it is one itself on a narrow
// window): removing, revoking, cancelling and leaving ask in the row or the
// footer (`share-dialog/RowConfirm`), and Change folders is a view in place
// of the list.
//
// On a plan without sharing (Free, Starter; Rust decides, `canShareDrives`)
// the owner still sees and removes everyone here, but Invite, New link,
// Share, Approve and Change folders give way to one upgrade card. A 403
// `shared_drives_not_entitled` from any change does the same.

"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import * as Dialog from "@radix-ui/react-dialog";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Folder, HardDrive, LogOut, X } from "lucide-react";
import { toast } from "sonner";

import { Button, Icons, Skeleton } from "@/components/ui";
import { useBreakpoint } from "@/app/lib/hooks";
import { invalidateOwnedDriveSharing } from "@/app/lib/hooks/useOwnedDriveSharing";
import {
  MY_FOLDER_GRANTS_QUERY_KEY,
  SHARED_DRIVE_MEMBERSHIPS_QUERY_KEY,
  useSharedDriveMemberships,
} from "@/app/lib/hooks/useSharedDriveRoles";
import { useStorageOverview } from "@/app/lib/hooks/api/useStorageOverview";
import { useSharedDrivesInPlan } from "@/app/lib/hooks/useSharedDrivesInPlan";
import { BILLING_ROUTE } from "@/app/lib/routes";
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
  approveEmailInvite,
  changeDriveMemberRole,
  isSharedDrivesNotEntitled,
  leaveSharedDrive,
  leaveSharedDriveByIdentity,
  removeDriveMember,
  replaceFolderGrants,
  revokeDriveInvite,
  type AccessPanel,
  type AccessPanelHolder,
  type DriveMembershipInfo,
} from "@/app/lib/tauri/sharedDrives";
import { parseFolderGrantLabel, parseSharedDriveLabel } from "@/app/lib/shared-drives/sharedDriveLabel";
import { accountDisplayName } from "@/app/lib/shared-drives/accountLabel";
import { frozenNotice } from "@/app/lib/shared-drives/writeRefusal";
import { errorMessage } from "@/app/lib/utils/errorUtils";

import { InlineNotice } from "./share-dialog/InlineNotice";
import { useRowChanges } from "./share-dialog/PeopleWithAccessSection";
import { ROW_TRIGGER, RowConfirm, RowConfirmProvider, useRowConfirm } from "./share-dialog/RowConfirm";
import ChangeFoldersView from "./access-panel/ChangeFoldersView";
import {
  FOLDER_ACCESS_HINT,
  SHARED_DRIVES_UNAVAILABLE_COPY,
  sharingGate,
  type SharingGate,
} from "./share-dialog/shareDialogState";
import { NotEntitledNotice, SharingActionsSkeleton } from "./share-dialog/SectionNoticeView";
import { driveDisplayName, findMembership } from "./share-dialog/ShareDialog";
import { useAccessPanel, type AccessPanelState } from "./access-panel/useAccessPanel";
import { EmptyAccess, EndedLinks, GroupHeader, PanelSkeleton, ShowAllGroup } from "./access-panel/AccessPanelRows";
import {
  FullViewHeader,
  FullViewList,
  LinkItem,
  PanelSearch,
  PendingItem,
  PersonItem,
  SummaryBar,
  type FullViewState,
  type RowActions,
  type RowContext,
  type SummaryItem,
} from "./access-panel/AccessPanelViews";
import {
  ACCESS_PANEL_COPY,
  MAIN_SEARCH_MIN_PEOPLE,
  MEMBER_JUMP_BAR_MIN_PEOPLE,
  PANEL_PREVIEW,
  SEARCH_PLACEHOLDER,
  isOnlyOwner,
  linkMatches,
  noMatchLine,
  normalizeQuery,
  panelPeople,
  panelSubline,
  peopleCount,
  pendingMatches,
  personKey,
  personMatches,
  planLabel,
  type LinksFilter,
  type PanelGroup,
  type PanelPerson,
} from "./access-panel/accessPanelView";

/** Wider than File Details' 305: this panel holds lists, not labels. */
const PANEL_WIDTH_PX = 360;

export default function ShareDrivePanel() {
  const [target, setTarget] = useAtom(shareDriveModalAtom);
  const { isDesktop, isLargeDesktop } = useBreakpoint();
  const onClose = useCallback(() => setTarget(null), [setTarget]);
  const open = Boolean(SHARED_DRIVES_ENABLED && target);

  // Remount for each target so nothing from the previous drive or folder (a
  // loaded list, an open menu, a row error, a question) carries over. One
  // provider for the whole panel: one row or the footer asks at a time.
  const body = target ? (
    <RowConfirmProvider key={`${target.label}|${target.pathPrefix ?? "\u0000"}|${target.ownerSs58 ?? ""}`}>
      <AccessPanelBody target={target} onClose={onClose} />
    </RowConfirmProvider>
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

  const { state, reload, retry } = useAccessPanel({ label: target.label, pathPrefix, target: driveTarget });

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

  // Whether this owner's plan lets them add people. Rust decides; a 403
  // from any change here flips it to the upgrade card as well.
  const router = useRouter();
  const planAllows = useSharedDrivesInPlan();
  const [refusedByServer, setRefusedByServer] = useState(false);
  const onNotEntitled = useCallback(() => setRefusedByServer(true), []);
  const upgrade = useCallback(() => {
    onClose();
    router.push(BILLING_ROUTE);
  }, [onClose, router]);

  const { busy, rowError, run } = useRowChanges(onChanged, reload, onNotEntitled);

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

  // Leaving is for anyone the drive is shared with. It asks in the footer.
  const [leaving, setLeaving] = useState<"idle" | "busy">("idle");
  const leaveConfirm = useRowConfirm<"leave">("leave");
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

  const actions = useMemo<RowActions>(
    () => ({
      changeRole: (ss58, who, role) =>
        void run(ss58, who, "saving", () => changeDriveMemberRole(target.label, ss58, role, driveTarget)),
      remove: (ss58, who) => void run(ss58, who, "removing", () => removeDriveMember(target.label, ss58, driveTarget)),
      revoke: (id, who) => void run(id, who, "revoking", () => revokeDriveInvite(target.label, id, driveTarget)),
      cancel: (id, who) => void run(id, who, "removing", () => revokeDriveInvite(target.label, id, driveTarget)),
      approve: (id, who) => void run(id, who, "saving", () => approveEmailInvite(target.label, id, driveTarget)),
      // Throws on refusal: the Change folders view shows why and stays. A plan
      // refusal also puts the upgrade card in place behind it.
      changeFolders: async (ss58, folders, role) => {
        try {
          await replaceFolderGrants(target.label, ss58, folders, { role, target: driveTarget });
        } catch (err) {
          if (isSharedDrivesNotEntitled(err)) onNotEntitled();
          throw err;
        }
        toast.success("Folders updated");
        onChanged();
        await reload();
      },
    }),
    [run, target.label, driveTarget, onChanged, reload, onNotEntitled],
  );
  // Only the owner adds people, so the gate is about the owner's plan.
  const gate = sharingGate({
    planAllows,
    owner: panel ? panel.canManage : expectManage,
    refusedByServer,
  });
  const ctx: RowContext | null = panel
    ? {
        panel,
        folder,
        busy,
        rowError,
        actions,
        locked: panel.linksLocked,
        unlocking,
        onUnlock: () => void unlock(),
        canAddAccess: gate === "allowed",
        openChangeFolders: (holder) => {
          beforeChanging.current = {
            scrollTop: scrollRef.current?.scrollTop ?? 0,
            who: accountDisplayName(holder.memberSs58, holder.memberName),
          };
          setChanging(holder);
        },
      }
    : null;
  const people = useMemo(() => (panel ? panelPeople(panel, membership?.ownerName) : []), [panel, membership?.ownerName]);

  // Change folders replaces the list (main or full view) until Back, never a
  // second dialog over the panel.
  const [changing, setChanging] = useState<AccessPanelHolder | null>(null);
  const beforeChanging = useRef<{ scrollTop: number; who: string } | null>(null);

  // The main view's search, which the full view starts from.
  const [mainQuery, setMainQuery] = useState("");
  // A full view replaces the list with one group, all of it. The Share
  // dialog's "+N more" row opens the panel straight on the people.
  const [fullView, setFullView] = useState<FullViewState | null>(() =>
    target.openOn === "people" ? { group: "people", query: "", peopleFilter: "all", linksFilter: "active" } : null,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  // Where the main list was, so Back returns to it rather than the top.
  const mainScrollTop = useRef(0);
  const restoreMainScroll = useRef(false);
  const openFullView = useCallback(
    (group: PanelGroup, linksFilter: LinksFilter = "active") => {
      mainScrollTop.current = scrollRef.current?.scrollTop ?? 0;
      setFullView({ group, query: mainQuery, peopleFilter: "all", linksFilter });
    },
    [mainQuery],
  );
  const closeFullView = useCallback(() => {
    restoreMainScroll.current = true;
    setFullView(null);
  }, []);
  const viewGroup = fullView?.group ?? null;

  // Back from Change folders: the list where it was, and focus on the row's
  // menu button it was opened from.
  const closeChanging = useCallback(() => setChanging(null), []);
  const isChanging = changing !== null;
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const before = beforeChanging.current;
    if (!scroller || !before) return;
    if (isChanging) {
      scroller.scrollTop = 0;
      return;
    }
    beforeChanging.current = null;
    scroller.scrollTop = before.scrollTop;
    const menu = Array.from(scroller.querySelectorAll<HTMLElement>("[aria-label]")).find(
      (el) => el.getAttribute("aria-label") === `Actions for ${before.who}`,
    );
    menu?.focus({ preventScroll: true });
  }, [isChanging]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    if (viewGroup) {
      scroller.scrollTop = 0;
    } else if (restoreMainScroll.current) {
      restoreMainScroll.current = false;
      scroller.scrollTop = mainScrollTop.current;
    }
  }, [viewGroup]);

  // The jump bar: scroll the list to a group, move focus to its heading and
  // mark it for a moment so the eye finds where it landed.
  const reducedMotion = useReducedMotion();
  const [flash, setFlash] = useState<PanelGroup | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );
  const jump = useCallback(
    (group: PanelGroup) => {
      const scroller = scrollRef.current;
      const heading = document.getElementById(GROUP_HEADING_ID[group]);
      if (!scroller || !heading) return;
      const top = heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 12;
      const behavior: ScrollBehavior = reducedMotion ? "auto" : "smooth";
      if (typeof scroller.scrollTo === "function") scroller.scrollTo({ top: Math.max(0, top), behavior });
      else scroller.scrollTop = Math.max(0, top);
      heading.focus({ preventScroll: true });
      setFlash(group);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(null), JUMP_HIGHLIGHT_MS);
    },
    [reducedMotion],
  );
  const summary = panel ? summaryItems(panel, people, mainQuery) : null;

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

      {panel && summary && !fullView && !changing ? <SummaryBar items={summary} onJump={jump} /> : null}
      {panel && fullView && !changing ? (
        <FullViewHeader
          view={fullView}
          total={groupTotal(panel, fullView.group)}
          onBack={closeFullView}
          onChange={setFullView}
        />
      ) : null}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {ctx && changing ? (
          <ChangeFoldersView
            who={accountDisplayName(changing.memberSs58, changing.memberName)}
            folders={changing.folders}
            onClose={closeChanging}
            onConfirm={(next, role) => actions.changeFolders(changing.memberSs58, next, role)}
          />
        ) : ctx && fullView ? (
          <FullViewList view={fullView} people={people} ctx={ctx} scrollRef={scrollRef} onChange={setFullView} />
        ) : (
          <PanelContent
            state={state}
            folder={folder}
            expectManage={expectManage}
            retry={retry}
            onShare={openShareDialog}
            gate={gate}
            onUpgrade={upgrade}
            ctx={ctx}
            people={people}
            query={mainQuery}
            onQuery={setMainQuery}
            flash={flash}
            onShowAll={openFullView}
          />
        )}
      </div>

      {leaveConfirm.asking ? (
        // Leaving asks here, in the footer, in place of its buttons.
        <footer className="shrink-0 border-t border-grey-80 px-4 py-1 dark:border-white/10">
          <RowConfirm
            question={`Leave “${title}”?`}
            detail={
              folder
                ? "You lose access to it, and to any other folder of the same drive shared with you."
                : "You lose access to its files. Anything already on this computer stays."
            }
            confirmLabel={folder ? "Leave folder" : "Leave drive"}
            onConfirm={() => {
              leaveConfirm.done();
              void leave();
            }}
            onCancel={leaveConfirm.cancel}
          />
        </footer>
      ) : state.kind === "ready" || state.kind === "loading" ? (
        <footer
          ref={leaveConfirm.rowRef as React.RefObject<HTMLElement>}
          tabIndex={-1}
          className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-grey-80 px-4 py-3 outline-none dark:border-white/10"
        >
          {sharedWithMe ? (
            <Button
              type="button"
              variant="defaultStable"
              size="auto"
              disabled={leaving === "busy"}
              onClick={() => leaveConfirm.ask("leave")}
              className="h-[38px] gap-1.5 rounded-[8px] px-3.5 text-sm font-medium text-error-70 dark:text-error-70"
              {...ROW_TRIGGER}
            >
              <LogOut className="size-4" aria-hidden />
              {leaving === "busy" ? "Leaving…" : folder ? "Leave folder" : "Leave drive"}
            </Button>
          ) : (
            <span className="hidden text-xs text-grey-50 @[340px]:inline dark:text-grey-dark-600">
              {ACCESS_PANEL_COPY.changesApply}
            </span>
          )}
          {canManage && gate === "loading" ? (
            // Holds the Share button's place until the plan is known, so
            // neither the button nor its absence flashes.
            <Skeleton width={92} height={38} className="ml-auto rounded-[8px]" />
          ) : canManage && gate === "allowed" ? (
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

    </div>
  );
}

/** The heading each group's jump lands on. */
const GROUP_HEADING_ID: Record<PanelGroup, string> = {
  people: "access-people",
  pending: "access-pending",
  links: "access-links",
};

/** How long a group's heading stays marked after a jump. */
const JUMP_HIGHLIGHT_MS = 1200;

/** Everyone or everything in a group, whatever the search. */
function groupTotal(panel: AccessPanel, group: PanelGroup): number {
  if (group === "people") return peopleCount(panel);
  if (group === "pending") return panel.pendingInvites.length;
  return panel.links.length;
}

/**
 * The jump bar's items, or null when there is nothing to jump between. The
 * owner gets one per group with rows (only when there is more than one);
 * anyone else only reads the people, so theirs is just "People N", and only
 * once there are more than `MEMBER_JUMP_BAR_MIN_PEOPLE` of them. While the
 * main search has text the counts are its matches, and a group with none
 * drops out, as it does from the list.
 */
function summaryItems(panel: AccessPanel, people: PanelPerson[], query: string): SummaryItem[] | null {
  const peopleShown = people.filter((p) => personMatches(p, query)).length;
  if (!panel.canManage) {
    if (peopleCount(panel) <= MEMBER_JUMP_BAR_MIN_PEOPLE || peopleShown === 0) return null;
    return [{ group: "people", count: peopleShown }];
  }
  if (isOnlyOwner(panel)) return null;
  const items: SummaryItem[] = [
    { group: "people", count: peopleShown },
    { group: "pending", count: panel.pendingInvites.filter((i) => pendingMatches(i, query)).length },
    { group: "links", count: panel.links.filter((l) => linkMatches(l, query)).length },
  ];
  const endedMatch = panel.inactiveLinks.some((l) => linkMatches(l, query));
  const withRows = items.filter((i) => i.count > 0 || (i.group === "links" && endedMatch));
  return withRows.length > 1 ? withRows : null;
}

function PanelContent({
  state,
  folder,
  expectManage,
  retry,
  onShare,
  gate,
  onUpgrade,
  ctx,
  people,
  query,
  onQuery,
  flash,
  onShowAll,
}: {
  state: AccessPanelState;
  folder: boolean;
  expectManage: boolean;
  retry: () => void;
  onShare: () => void;
  /** Whether Invite, New link and Share are offered, or the upgrade card. */
  gate: SharingGate;
  onUpgrade: () => void;
  ctx: RowContext | null;
  people: PanelPerson[];
  query: string;
  onQuery: (next: string) => void;
  flash: PanelGroup | null;
  onShowAll: (group: PanelGroup, linksFilter?: LinksFilter) => void;
}) {
  if (state.kind === "loading") return <PanelSkeleton withLinks={expectManage} />;
  if (state.kind === "unavailable") {
    return (
      <InlineNotice tone="info" className="mt-4">
        {SHARED_DRIVES_UNAVAILABLE_COPY}
      </InlineNotice>
    );
  }
  if (state.kind === "error" || !ctx) {
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
        {state.kind === "error" ? state.message : ""}
      </InlineNotice>
    );
  }

  const panel = ctx.panel;
  // Only the owner adds people; for anyone else there is nothing to gate.
  const upgradeCard =
    panel.canManage && gate === "upgrade" ? <NotEntitledNotice onUpgrade={onUpgrade} className="mt-3" /> : null;
  const addAction = <T,>(action: T): T | undefined =>
    panel.canManage && gate === "allowed" ? action : undefined;
  if (isOnlyOwner(panel)) {
    return (
      <>
        {upgradeCard}
        <GroupHeader id="access-people" title="People" count={1} />
        <PersonItem person={people[0]} ctx={ctx} />
        {gate === "allowed" ? (
          <EmptyAccess folder={folder} onShare={onShare} />
        ) : gate === "loading" ? (
          <SharingActionsSkeleton className="mt-4" />
        ) : null}
      </>
    );
  }

  // Typing in the main search filters every group at once; each still draws
  // its first rows, and "Show all" opens the full view on the same search.
  const searching = normalizeQuery(query) !== "";
  const peopleShown = people.filter((p) => personMatches(p, query));
  const pendingShown = panel.canManage ? panel.pendingInvites.filter((i) => pendingMatches(i, query)) : [];
  const linksShown = panel.canManage ? panel.links.filter((l) => linkMatches(l, query)) : [];
  const endedShown = panel.canManage ? panel.inactiveLinks.filter((l) => linkMatches(l, query)) : [];
  const nothing =
    searching && peopleShown.length + pendingShown.length + linksShown.length + endedShown.length === 0;

  return (
    <>
      {upgradeCard}
      {peopleCount(panel) > MAIN_SEARCH_MIN_PEOPLE ? (
        <PanelSearch
          value={query}
          onChange={onQuery}
          label={SEARCH_PLACEHOLDER.main}
          placeholder={SEARCH_PLACEHOLDER.main}
          className="mt-3"
        />
      ) : null}
      {nothing ? (
        <p role="status" className="px-1 py-8 text-center text-sm text-grey-50 dark:text-grey-dark-600">
          {noMatchLine(query)}
        </p>
      ) : null}

      {peopleShown.length > 0 ? (
        <section aria-labelledby="access-people">
          <GroupHeader
            id="access-people"
            title="People"
            count={peopleCount(panel)}
            highlighted={flash === "people"}
            action={addAction({ label: "Invite", onClick: onShare })}
          />
          <ul>
            {peopleShown.slice(0, PANEL_PREVIEW.people).map((person) => (
              <li key={personKey(person)}>
                <PersonItem person={person} ctx={ctx} />
              </li>
            ))}
          </ul>
          {peopleShown.length > PANEL_PREVIEW.people ? (
            <ShowAllGroup group="people" total={peopleShown.length} onClick={() => onShowAll("people")} />
          ) : null}
          {/* There is no role change for a folder holder (HCFS #475), so the
              list says what to do instead of offering a control the server
              would refuse. */}
          {panel.canManage && folder && panel.folderHolders.length > 0 ? (
            <p className="mt-1 px-0.5 text-xs text-grey-50 dark:text-grey-dark-600">{FOLDER_ACCESS_HINT}</p>
          ) : null}
        </section>
      ) : null}

      {pendingShown.length > 0 ? (
        <section aria-labelledby="access-pending">
          <GroupHeader
            id="access-pending"
            title="Pending invites"
            count={panel.pendingInvites.length}
            highlighted={flash === "pending"}
          />
          <ul>
            {pendingShown.slice(0, PANEL_PREVIEW.pending).map((invite) => (
              <li key={invite.inviteId}>
                <PendingItem invite={invite} ctx={ctx} />
              </li>
            ))}
          </ul>
          {pendingShown.length > PANEL_PREVIEW.pending ? (
            <ShowAllGroup group="pending" total={pendingShown.length} onClick={() => onShowAll("pending")} />
          ) : null}
        </section>
      ) : null}

      {panel.canManage && (!searching || linksShown.length + endedShown.length > 0) ? (
        <section aria-labelledby="access-links">
          <GroupHeader
            id="access-links"
            title="Links"
            count={`${panel.links.length} active`}
            highlighted={flash === "links"}
            action={addAction({ label: "New link", onClick: onShare })}
          />
          {ctx.locked && linksShown.length > 0 ? (
            <InlineNotice tone="info" className="mb-1">
              {ACCESS_PANEL_COPY.linksLocked}
            </InlineNotice>
          ) : null}
          <ul>
            {linksShown.slice(0, PANEL_PREVIEW.links).map((link) => (
              <li key={link.inviteId}>
                <LinkItem link={link} ctx={ctx} />
              </li>
            ))}
          </ul>
          {linksShown.length > PANEL_PREVIEW.links ? (
            <ShowAllGroup group="links" total={linksShown.length} onClick={() => onShowAll("links")} />
          ) : null}
          <EndedLinks links={endedShown} onShowAll={() => onShowAll("links", "ended")} />
        </section>
      ) : null}
    </>
  );
}
