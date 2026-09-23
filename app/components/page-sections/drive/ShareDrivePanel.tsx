// Owner-side management modal for a shared drive: mint invite links and
// list/remove members. Opened via `shareDriveModalAtom` (the
// `ShareFileModal` singleton pattern — mounted once in the pages layout,
// any surface opens it by setting the atom). Own drives only: the
// "Share drive…" menu item is hidden for member rows and the backend
// refuses a member label as `Validation`.
//
// Invite minting lives in `CreateDriveInviteDialog` (a separate dialog).
// This panel's Links tab lists invites the server still holds, opens sealed
// tokens in Rust, and offers copy / revoke — console parity for seal-back.

"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import * as Dialog from "@radix-ui/react-dialog";
import dynamic from "next/dynamic";
import { useAtom, useSetAtom } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, Copy, Lock, UserRoundPen, Users, X } from "lucide-react";
import { toast } from "sonner";

import { Button, Icons } from "@/components/ui";
import { FramedDialog } from "@/components/ui/FramedDialog";
import ConfirmationDialog from "@/components/ConfirmationDialog";
import TableActionMenu from "@/components/ui/alt-table/TableActionMenu";
import { Select } from "@/components/ui/select/Select";
import DriveRoleChip from "./DriveRoleChip";
import { useBreakpoint } from "@/app/lib/hooks";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { invalidateOwnedDriveSharing } from "@/app/lib/hooks/useOwnedDriveSharing";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import {
  createDriveInviteDialogAtom,
  shareDriveModalAtom,
} from "@/app/lib/global-atoms/sharesAtoms";
import {
  changeDriveMemberRole,
  isSharedDrivesUnavailable,
  listDriveInvites,
  listDriveMembers,
  removeDriveMember,
  revokeDriveInvite,
  type DriveInviteInfo,
  type DriveMemberInfo,
} from "@/app/lib/tauri/sharedDrives";
import {
  deadReasonLabel,
  inviteRowView,
} from "@/app/lib/shared-drives/inviteRowView";
import { truncateInviteUrl } from "@/app/lib/shared-drives/inviteLink";
import { cn } from "@/lib/utils";
import {
  DRIVE_ROLES,
  driveRoleDemotionWarning,
  driveRoleDescription,
  driveRoleLabel,
  parseDriveRole,
  type DriveRole,
} from "@/app/lib/shared-drives/roles";
import { accountDisplayName } from "@/app/lib/shared-drives/accountLabel";
import { inviteDriveDisplayName } from "@/app/lib/shared-drives/inviteDriveName";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import {
  formatJoinedDate,
  getInvitesView,
  getMembersView,
  type InvitesState,
  type MembersState,
} from "./shareDriveModalState";

const Avatar = dynamic(() => import("boring-avatars"), { ssr: false });

/** Wider than File Details' 305: this panel holds lists, not labels. */
const PANEL_WIDTH_PX = 360;

type Tab = "members" | "links";

export default function ShareDrivePanel() {
  const [target, setTarget] = useAtom(shareDriveModalAtom);
  const queryClient = useQueryClient();
  // Own links say nothing extra; somebody else's name who made them.
  const { polkadotAddress } = useWalletAuth();
  const { isDesktop, isLargeDesktop } = useBreakpoint();

  const setInviteDialogTarget = useSetAtom(createDriveInviteDialogAtom);

  // Members first: it is what someone opens this for once the drive is
  // already shared, which is the only state it opens in.
  const [tab, setTab] = useState<Tab>("members");
  const [members, setMembers] = useState<MembersState>({ kind: "idle" });
  const [invites, setInvites] = useState<InvitesState>({ kind: "idle" });

  const label = target?.label ?? null;
  // Named only for a drive this account has NOT synced here; an own drive's
  // label resolves on its own. `useMemo` so the identity is a stable value in
  // the callbacks' dependency lists.
  const driveTarget = useMemo(
    () =>
      target?.ownerSs58 && target?.folderHash
        ? { ownerSs58: target.ownerSs58, folderHash: target.folderHash }
        : undefined,
    [target?.ownerSs58, target?.folderHash],
  );
  // Stale-async guard: the modal never unmounts and `label` changes on
  // close/reopen, so a response still in flight for a previous drive must
  // not land on the current session's state (the reset effect below runs
  // before the late response resolves, then the response would clobber it).
  const currentLabelRef = useRef<string | null>(null);
  currentLabelRef.current = label;

  // Reset on every session transition, close included — the modal never
  // unmounts, so without this a previous drive's invite link or member
  // list would survive into the next open.
  useEffect(() => {
    setTab("members");
    setMembers({ kind: "idle" });
    setInvites({ kind: "idle" });
  }, [label]);

  const loadMembers = useCallback(async (driveLabel: string) => {
    setMembers({ kind: "loading" });
    try {
      const rows = await listDriveMembers(driveLabel, driveTarget);
      if (driveLabel !== currentLabelRef.current) return;
      setMembers({ kind: "ready", members: rows });
    } catch (err) {
      if (driveLabel !== currentLabelRef.current) return;
      if (isSharedDrivesUnavailable(err)) {
        // Feature-off server: quiet degrade, never a toast.
        setMembers({ kind: "unavailable" });
      } else {
        setMembers({ kind: "error", message: errorMessage(err) });
      }
    }
  }, [driveTarget]);

  const loadInvites = useCallback(async (driveLabel: string) => {
    setInvites({ kind: "loading" });
    try {
      const rows = await listDriveInvites(driveLabel, driveTarget);
      if (driveLabel !== currentLabelRef.current) return;
      setInvites({ kind: "ready", invites: rows });
    } catch (err) {
      if (driveLabel !== currentLabelRef.current) return;
      if (isSharedDrivesUnavailable(err)) {
        setInvites({ kind: "unavailable" });
      } else {
        setInvites({ kind: "error", message: errorMessage(err) });
      }
    }
  }, [driveTarget]);

  const revokeInvite = useCallback(
    async (inviteId: string) => {
      if (!label) return;
      const labelAtCall = label;
      try {
        await revokeDriveInvite(labelAtCall, inviteId, driveTarget);
        toast.success("Link revoked");
        void invalidateOwnedDriveSharing(queryClient);
        await loadInvites(labelAtCall);
      } catch (err) {
        if (labelAtCall !== currentLabelRef.current) return;
        toast.error(`Could not revoke the link: ${errorMessage(err)}`);
      }
    },
    [label, loadInvites, queryClient, driveTarget],
  );

  // Same lazy rule as members: the tab pays for its own listing.
  useEffect(() => {
    if (!label || tab !== "links") return;
    if (invites.kind !== "idle") return;
    void loadInvites(label);
  }, [label, tab, invites.kind, loadInvites]);

  // Lazy members fetch: first activation of the tab only, so minting an
  // invite costs no member-listing round-trip.
  useEffect(() => {
    if (!label || tab !== "members") return;
    if (members.kind !== "idle") return;
    void loadMembers(label);
  }, [label, tab, members.kind, loadMembers]);

  // Auto-copy once we reach `done`; the URL stays in a selectable textbox
  // so the user can re-copy if focus rules block the auto-copy.

  const removeMember = useCallback(
    async (memberSs58: string) => {
      if (!label) return;
      const labelAtCall = label;
      try {
        await removeDriveMember(labelAtCall, memberSs58, driveTarget);
        toast.success("Member removed");
        void invalidateOwnedDriveSharing(queryClient);
        await loadMembers(labelAtCall);
      } catch (err) {
        if (labelAtCall !== currentLabelRef.current) return;
        if (isSharedDrivesUnavailable(err)) {
          setMembers({ kind: "unavailable" });
        } else {
          toast.error(`Could not remove member: ${errorMessage(err)}`);
        }
      }
    },
    [label, loadMembers, queryClient, driveTarget],
  );

  const changeRole = useCallback(
    async (memberSs58: string, role: DriveRole) => {
      if (!label) return;
      const labelAtCall = label;
      try {
        await changeDriveMemberRole(labelAtCall, memberSs58, role, driveTarget);
        // The new role binds on the member's next request, so there is no
        // propagation delay to caveat.
        toast.success(`Role changed to ${driveRoleLabel(role)}`);
        void invalidateOwnedDriveSharing(queryClient);
        await loadMembers(labelAtCall);
      } catch (err) {
        if (labelAtCall !== currentLabelRef.current) return;
        if (isSharedDrivesUnavailable(err)) {
          setMembers({ kind: "unavailable" });
        } else {
          // The backend's refusals are written for the user -- "you cannot
          // change your own role", the named role, the manager caps -- so
          // they are surfaced verbatim rather than replaced.
          toast.error(`Could not change role: ${errorMessage(err)}`);
        }
      }
    },
    [label, loadMembers, queryClient, driveTarget],
  );

  const onClose = () => setTarget(null);
  const open = Boolean(SHARED_DRIVES_ENABLED && target);

  // Body first, so the inline panel and the small-screen overlay render
  // exactly the same thing and cannot drift.
  const body = target ? (
      <div className="flex h-full flex-col px-3 pt-4 font-geist">
        <div className="mb-4 flex items-start justify-between gap-2 px-2">
          <div className="min-w-0">
            <p className="text-[16px] font-medium leading-5 text-black-900 dark:text-white">
              Share access
            </p>
            <p className="mt-0.5 min-w-0 truncate text-[13px] text-black-900/40 dark:text-white/40">
              {inviteDriveDisplayName(target.folderName, target.label)}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="mt-1 flex size-[18px] shrink-0 items-center justify-center rounded-md bg-[#0000000F] text-black-900/40 transition-colors hover:bg-black/15 hover:text-black-900 dark:bg-[#FFFFFF0F] dark:text-grey-light-100/40 dark:hover:bg-white/25 dark:hover:text-white"
          >
            <X className="size-[10px]" strokeWidth={2.5} />
          </button>
        </div>

        <div className="mb-5">
          <SegmentedControl<Tab>
            ariaLabel="Share drive sections"
            fullWidth
            value={tab}
            onChange={setTab}
            options={[
              { label: "Members", value: "members" },
              { label: "Links", value: "links" },
            ]}
          />
        </div>

        {tab === "links" ? (
          <LinksTab
            state={invites}
            onRevoke={(id) => void revokeInvite(id)}
            onClose={() => setTarget(null)}
            viewerSs58={polkadotAddress}
          />
        ) : (
          <MembersTab
            state={members}
            driveName={
              inviteDriveDisplayName(
                target?.folderName,
                target?.label ?? label,
              ) || "this drive"
            }
            onRemove={(ss58) => void removeMember(ss58)}
            onChangeRole={(ss58, role) => void changeRole(ss58, role)}
            onCreateInvite={() => {
              if (!target) return;
              // Close the panel as the dialog opens. They are two surfaces for
              // one drive, and a focused mint does not need the list behind
              // it -- which also avoids the dialog opening underneath the
              // panel's own overlay on small screens, where the panel sits
              // above FramedDialog's layer.
              setTarget(null);
              setInviteDialogTarget(target);
            }}
          />
        )}
      </div>
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
            <div className="h-full overflow-y-auto" style={{ width: PANEL_WIDTH_PX }}>
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
          className="fixed bottom-0 right-0 top-0 z-[1003] w-full max-w-[360px] overflow-y-auto bg-cover bg-fixed bg-center bg-no-repeat font-geist animate-panel-in bg-[url('/logged-in-app-background.png')] dark:bg-[url('/logged-in-app-background-dark.png')]"
        >
          <Dialog.Title className="sr-only">Share access</Dialog.Title>
          {body}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}


/**
 * The live invite links for this drive, and the only way to kill one.
 *
 * A minted link could not be revoked at all before this: the desktop never
 * persists tokens and the server stores only their hashes, so a link handed to
 * the wrong person stayed live for as long as it was configured to -- forever,
 * for a "never expires" one. Removing a member does not help; that revokes
 * somebody who already joined, not the link still circulating.
 */
function LinksTab({
  state,
  onRevoke,
  onClose,
  viewerSs58,
}: {
  state: InvitesState;
  onRevoke: (inviteId: string) => void;
  onClose: () => void;
  viewerSs58?: string | null;
}) {
  const view = getInvitesView(state);

  if (view === "unavailable") return <SharedDrivesUnavailableNotice onClose={onClose} />;

  if (view === "loading") {
    return (
      <p className="py-6 text-center text-sm text-grey-50 dark:text-grey-dark-600">
        Loading links…
      </p>
    );
  }

  if (view === "error") {
    return (
      <p className="py-6 text-center text-sm text-error-70">
        {state.kind === "error" ? state.message : "Could not load links"}
      </p>
    );
  }

  if (view === "empty") {
    return (
      <p className="py-6 text-center text-sm text-grey-50 dark:text-grey-dark-600">
        No invite links yet. Create one from the Invite tab.
      </p>
    );
  }

  const invites = state.kind === "ready" ? state.invites : [];
  return (
    <div className="max-h-[260px] overflow-y-auto">
      {invites.map((invite) => (
        <InviteRow
          key={invite.inviteId}
          invite={invite}
          onRevoke={onRevoke}
          viewerSs58={viewerSs58}
        />
      ))}
    </div>
  );
}

function InviteRow({
  invite,
  onRevoke,
  viewerSs58,
}: {
  invite: DriveInviteInfo;
  onRevoke: (inviteId: string) => void;
  viewerSs58?: string | null;
}) {
  // The same two-step inline confirm the member row uses: revoking is
  // irreversible and the row is small.
  const [confirming, setConfirming] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const view = inviteRowView(invite, undefined, viewerSs58);

  const handleCopy = async () => {
    if (!invite.inviteUrl || copying) return;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(invite.inviteUrl);
      // Toast never carries the URL — it contains the drive key in `#k=`.
      toast.success("Invite link copied");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy invite link");
    } finally {
      setCopying(false);
    }
  };

  return (
    <div className="border-b border-grey-90 py-2.5 last:border-b-0 dark:border-white/10">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-grey-10 dark:text-white">
            {view.summary}
          </p>
          <p className="truncate text-[11px] text-grey-50 dark:text-grey-dark-600">
            {view.live ? view.expiry : deadReasonLabel(view.deadReason)}
            {/* Only somebody ELSE's link says who made it. Now that a manager
                can mint, a drive's links no longer all come from one person,
                and "who let them in" is a question the list has to answer. */}
            {view.mintedBy && (
              <>
                {" "}
                · by{" "}
                {accountDisplayName(
                  view.mintedBy,
                  invite.mintedByName,
                  14,
                )}
              </>
            )}
          </p>
        </div>

        {view.live ? (
          confirming ? (
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="ghost"
                size="auto"
                onClick={() => {
                  setConfirming(false);
                  onRevoke(invite.inviteId);
                }}
                className="h-7 rounded-md border border-error-50/40 px-2 text-xs font-medium text-error-50 hover:bg-error-50/10"
              >
                Confirm revoke
              </Button>
              <Button
                variant="ghost"
                size="auto"
                onClick={() => setConfirming(false)}
                className="h-7 rounded-md px-2 text-xs font-medium text-grey-50 hover:bg-grey-90 dark:text-grey-dark-600 dark:hover:bg-white/10"
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="auto"
              onClick={() => setConfirming(true)}
              className="h-7 shrink-0 rounded-md border border-grey-80 px-2 text-xs font-medium text-grey-30 hover:bg-grey-90 dark:border-white/10 dark:text-grey-dark-600 dark:hover:bg-white/10"
            >
              Revoke
            </Button>
          )
        ) : (
          // A dead link needs no action; showing a disabled Revoke would imply
          // there is something left to do.
          <span className="shrink-0 text-[11px] text-grey-60 dark:text-grey-dark-600">
            No longer works
          </span>
        )}
      </div>

      {/* Console parity: sealed + valid → link field (ready / locked).
          Revoked / pre-seal-back rows omit it. Never render `#k=`. */}
      {invite.linkAvailable ? (
        <InviteLinkField
          url={invite.inviteUrl}
          copying={copying}
          copied={copied}
          onCopy={() => void handleCopy()}
        />
      ) : null}
    </div>
  );
}

/**
 * The invite's link field — same three visual states as console
 * `InviteLinkRows.InviteLinkField`, without the unlock gate (Rust opens
 * blobs inside `list_drive_invites`; absence of `url` is locked).
 */
const LOCKED_LINK_PLACEHOLDER =
  "https://console.hippius.com/invite/Xk29fLpQ7rTnB4vW8yHc";

const LINK_FIELD =
  "mt-2 flex w-full min-w-0 items-center gap-2 rounded-[6px] border border-grey-80 bg-grey-90/40 px-2.5 py-1.5 text-left transition-colors dark:border-white/10 dark:bg-white/5";

function InviteLinkField({
  url,
  copying,
  copied,
  onCopy,
}: {
  url: string | undefined;
  copying: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  if (url) {
    return (
      <button
        type="button"
        title="Copy invite link"
        aria-label="Copy invite link"
        disabled={copying}
        onClick={onCopy}
        className={cn(
          LINK_FIELD,
          "group hover:border-primary-50 disabled:opacity-60 dark:hover:border-[#82a3f0]",
        )}
      >
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] leading-4 text-grey-30 dark:text-grey-dark-500">
          {truncateInviteUrl(url)}
        </span>
        {copied ? (
          <Check
            aria-hidden
            className="size-3.5 shrink-0 text-success-40 dark:text-success-50"
          />
        ) : (
          <Copy
            aria-hidden
            className="size-3.5 shrink-0 text-grey-50 transition-colors group-hover:text-primary-50 dark:text-grey-dark-700 dark:group-hover:text-[#82a3f0]"
          />
        )}
      </button>
    );
  }

  return (
    <div
      role="status"
      aria-label="Link locked"
      title="Could not rebuild this invite link"
      className={LINK_FIELD}
    >
      <span
        aria-hidden
        className="min-w-0 flex-1 select-none truncate font-mono text-[11px] leading-4 text-grey-30 blur-[3px] dark:text-grey-dark-500"
      >
        {LOCKED_LINK_PLACEHOLDER}
      </span>
      <Lock
        aria-hidden
        className="size-3.5 shrink-0 text-grey-50 dark:text-grey-dark-700"
      />
    </div>
  );
}

function MembersTab({
  state,
  driveName,
  onRemove,
  onChangeRole,
  onCreateInvite,
}: {
  state: MembersState;
  driveName: string;
  onRemove: (memberSs58: string) => void;
  onChangeRole: (memberSs58: string, role: DriveRole) => void;
  onCreateInvite: () => void;
}) {
  const view = getMembersView(state);

  if (view === "loading") {
    return (
      <p className="py-8 text-center text-sm text-grey-50 dark:text-grey-dark-600">Loading members…</p>
    );
  }

  if (view === "unavailable") {
    return (
      <p className="py-8 text-center text-sm text-grey-50 dark:text-grey-dark-600">
        Shared drives aren&apos;t available on your server yet.
      </p>
    );
  }

  if (view === "error") {
    return (
      <div className="mb-2 flex items-start gap-2 rounded-md border border-error-90 bg-error-100/40 px-3 py-2.5 dark:border-error-30/60 dark:bg-error-30/10">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-error-70" />
        <p className="break-words text-xs text-grey-50 dark:text-grey-dark-600">
          {state.kind === "error" ? state.message : "Couldn't load members"}
        </p>
      </div>
    );
  }

  if (view === "empty") {
    return (
      <div className="py-6 text-center">
        <p className="mb-4 text-sm text-grey-50 dark:text-grey-dark-600">
          No one has joined this drive yet.
        </p>
        <InviteButton onClick={onCreateInvite} />
      </div>
    );
  }

  const members = state.kind === "ready" ? state.members : [];
  return (
    <div>
      <div className="mb-3">
        <InviteButton onClick={onCreateInvite} hasMembers />
      </div>
      <div className="max-h-[320px] overflow-y-auto">
        {members.map((member) => (
          <MemberRow
            key={member.memberSs58}
            member={member}
            driveName={driveName}
            onRemove={onRemove}
            onChangeRole={onChangeRole}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The one way into the mint flow, which is a dialog rather than a tab.
 *
 * The label follows the drive's state. "Create invite link" is right for a
 * drive nobody has joined -- it names the artefact, which is the thing that
 * does not exist yet. Once people are in, the artefact is not the point any
 * more and the same words read as though the earlier link had failed.
 */
function InviteButton({
  onClick,
  hasMembers = false,
}: {
  onClick: () => void;
  hasMembers?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="primary"
      size="auto"
      onClick={onClick}
      className="h-[34px] w-full rounded-[8px] text-[13px] font-medium"
    >
      {hasMembers ? "Invite more people" : "Create invite link"}
    </Button>
  );
}

/**
 * Changing a member's role, as a dialog.
 *
 * The role used to be an inline `Select` on the row, which committed on
 * selection: a mis-click silently changed what somebody could do to the
 * drive, with only a toast to say so. A role is a decision, so it gets the
 * app's decision surface -- pick, read what it grants, press Save -- and the
 * row keeps a three-dot menu like every other row in the app.
 */
function ChangeRoleDialog({
  member,
  onClose,
  onConfirm,
}: {
  member: DriveMemberInfo;
  onClose: () => void;
  onConfirm: (role: DriveRole) => void;
}) {
  const current = parseDriveRole(member.role);
  const [role, setRole] = useState<DriveRole>(current);
  const demotionWarning = driveRoleDemotionWarning(current, role);

  return (
    <FramedDialog
      open
      onClose={onClose}
      title="Change role"
      icon={<Users className="size-4 text-white" />}
      maxWidth="max-w-[585px]"
      contentClassName="sm:w-[405px]"
    >
      <div className="font-geist">
        <p className="mb-5 break-all text-center font-mono text-xs text-grey-50 dark:text-grey-dark-600">
          {member.memberSs58}
        </p>

        <div className="mb-6 flex flex-col gap-1.5">
          <span className="text-xs font-medium text-grey-30 dark:text-grey-dark-700">
            They join as
          </span>
          <Select
            ariaLabel="Member role"
            value={role}
            onValueChange={(value) => setRole(value as DriveRole)}
            options={DRIVE_ROLES.map((r) => ({
              label: driveRoleLabel(r),
              value: r,
            }))}
          />
          <p className="mt-1 text-xs text-grey-50 dark:text-grey-dark-600">
            {driveRoleDescription(role)}
          </p>
          {/* A demotion has a side effect nobody would guess: the server
              revokes the link that admitted this member when it outranks
              their new role, and demoting a manager revokes every link that
              manager minted. Said here, before Save, rather than discovered
              later as links that stopped working. */}
          {demotionWarning && (
            <p className="mt-1.5 text-xs text-grey-50 dark:text-grey-dark-600">
              {demotionWarning}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <Button
            type="button"
            variant="primary"
            size="auto"
            // Saving the role somebody already has is a round-trip that
            // changes nothing, so the button says there is nothing to do.
            disabled={role === current}
            onClick={() => {
              onConfirm(role);
              onClose();
            }}
            className="h-[38px] w-full rounded-[8px] text-[14px] font-medium leading-[1.4] tracking-[-0.28px]"
          >
            Save role
          </Button>
          <Button
            type="button"
            variant="defaultStable"
            size="auto"
            onClick={onClose}
            className="h-[38px] w-full rounded-[8px] border border-grey-80 text-[14px] font-medium leading-[1.4] tracking-[-0.28px] text-grey-10 dark:border-white/10 dark:text-white"
          >
            Cancel
          </Button>
        </div>
      </div>
    </FramedDialog>
  );
}

function MemberRow({
  member,
  driveName,
  onRemove,
  onChangeRole,
}: {
  member: DriveMemberInfo;
  driveName: string;
  onRemove: (memberSs58: string) => void;
  onChangeRole: (memberSs58: string, role: DriveRole) => void;
}) {
  // Both destructive-ish actions are dialogs rather than inline controls.
  // The row is 360px wide in a panel; an inline two-step confirm and a role
  // select were competing for the same few pixels as the address they act on.
  const [dialog, setDialog] = useState<"none" | "role" | "remove">("none");
  const joined = formatJoinedDate(member.createdAt);
  const role = parseDriveRole(member.role);

  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b border-grey-90 py-2.5 last:border-b-0 dark:border-white/10">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="size-[28px] shrink-0 overflow-hidden rounded-full">
            <Avatar name={member.memberSs58} size={28} variant="pixel" />
          </div>
          <div className="min-w-0">
            <p
              className="truncate font-mono text-xs text-grey-10 dark:text-white"
              title={member.memberSs58}
            >
              {accountDisplayName(member.memberSs58, member.memberName)}
            </p>
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5">
              {/* The role reads as a chip here too, so a member list and a
                  drive list say access the same way. An unknown role
                  degrades to Viewer rather than reading as management. */}
              <DriveRoleChip role={role} />
              {joined && (
                <span className="truncate text-[11px] text-grey-50 dark:text-grey-dark-600">
                  Joined {joined}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* The same overflow menu every other row in the app carries, so a
            member row is operated the way a drive row is. */}
        <TableActionMenu
          dropdownTitle=""
          items={[
            {
              icon: <UserRoundPen className="size-4" />,
              itemTitle: "Change role",
              onItemClick: () => setDialog("role"),
            },
            {
              icon: <Icons.Trash className="size-4" />,
              itemTitle: "Remove from drive",
              variant: "destructive",
              onItemClick: () => setDialog("remove"),
            },
          ]}
        >
          <Button
            variant="ghost"
            size="auto"
            aria-label={`Actions for ${member.memberSs58}`}
            className="h-7 w-7 shrink-0 rounded-md p-0 text-grey-70 transition-colors hover:bg-grey-90 hover:text-grey-30 dark:text-grey-dark-600 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <Icons.EllipsisVertical className="size-[18px]" />
          </Button>
        </TableActionMenu>
      </div>

      {dialog === "role" && (
        <ChangeRoleDialog
          member={member}
          onClose={() => setDialog("none")}
          onConfirm={(next) => onChangeRole(member.memberSs58, next)}
        />
      )}

      <ConfirmationDialog
        open={dialog === "remove"}
        onClose={() => setDialog("none")}
        onBack={() => setDialog("none")}
        onConfirm={() => {
          setDialog("none");
          onRemove(member.memberSs58);
        }}
        heading="Remove from drive"
        icon={<Icons.Trash className="size-4 text-white" />}
        iconBgColor="bg-[#fc7d73]"
        confirmVariant="destructive"
        confirmButtonClassName="text-white"
        button="Remove"
        text={`Remove this member from "${driveName}"?`}
        helperText="They lose access on their next request. Files already downloaded to their device stay there, and any invite link still circulating keeps working — revoke it in the Links tab."
      />
    </>
  );
}

function SharedDrivesUnavailableNotice({ onClose }: { onClose: () => void }) {
  return (
    <div>
      <p className="mb-6 py-4 text-center text-sm text-grey-50 dark:text-grey-dark-600">
        Shared drives aren&apos;t available on your server yet.
      </p>
      <Button type="button" variant="defaultStable" size="auto" onClick={onClose} className={secondaryButtonClass}>
        Close
      </Button>
    </div>
  );
}

const secondaryButtonClass = "h-[52px] w-full rounded-[6px] text-base font-normal tracking-[-0.36px]";
