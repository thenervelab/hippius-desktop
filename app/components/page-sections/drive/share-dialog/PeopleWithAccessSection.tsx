"use client";

// "People with access": the owner, you, then everyone else in the drive (or
// holding the folder), then emailed invitations still waiting. Who belongs
// here is decided in Rust (`list_share_access`); this section only draws the
// rows and sends each change through the existing commands.
//
// Changes are pessimistic: the row says "Saving…" or "Removing…" until the
// command has succeeded AND the listing has been read again, and a refusal
// leaves the row as it was with the reason under it. Other rows stay usable
// meanwhile. Removing someone, cancelling an invitation and a demotion (the
// server also revokes links as part of it) ask first, in the row itself
// (`RowConfirm`), never in a second dialog over this one. A folder holder has
// no role change (HCFS #475): the row offers Remove and the list says to
// invite them again.

import React, { useCallback, useState } from "react";
import dynamic from "next/dynamic";
import { ArrowRight, Loader2, Mail, Users } from "lucide-react";

import { Button, Skeleton } from "@/components/ui";
import { Select } from "@/components/ui/select/Select";
import MiddleTruncate from "@/components/ui/MiddleTruncate";
import AccountLabel from "../AccountLabel";
import { cn } from "@/lib/utils";
import {
  approveEmailInvite,
  changeDriveMemberRole,
  isSharedDrivesNotEntitled,
  removeDriveMember,
  revokeDriveInvite,
  type DriveInviteInfo,
  type DriveTarget,
  type ShareAccessHolder,
  type ShareAccessMember,
} from "@/app/lib/tauri/sharedDrives";
import {
  DRIVE_ROLES,
  driveRoleDemotionWarning,
  driveRoleDescription,
  driveRoleLabel,
  parseDriveRole,
  type DriveRole,
} from "@/app/lib/shared-drives/roles";
import { accountDisplayName } from "@/app/lib/shared-drives/accountLabel";
import { errorMessage } from "@/lib/utils/errorUtils";
import { InlineNotice } from "./InlineNotice";
import { ROW_TRIGGER, RowConfirm, RowConfirmProvider, useRowConfirm } from "./RowConfirm";
import {
  FOLDER_ACCESS_HINT,
  PEOPLE_MAX_ROWS,
  SHARED_DRIVES_UNAVAILABLE_COPY,
  couldNotChangeAccess,
  pendingInviteMeta,
} from "./shareDialogState";
import type { ShareAccessState } from "./useShareAccess";

const Avatar = dynamic(() => import("boring-avatars"), { ssr: false });

/** The value the row's select uses for "Remove access". Never a role. */
const REMOVE = "remove";

/**
 * Every person row is three columns: the avatar (fixed), the words (take
 * what is left and cut each line short with an ellipsis) and the role on the
 * right, in a slot of one fixed width. Without the fixed slot a long name ran
 * on under the role select. The right column ends flush with the section's
 * right edge, under the header's "Manage access": the slot's contents sit at
 * its right end, and a row's action (a folder holder's Remove) comes after
 * the role, last.
 */
export const ROW = "flex min-h-[48px] min-w-0 items-center gap-3 py-2";
/** The words column: never wider than what the avatar and the role leave. */
export const TEXT_COLUMN = "min-w-0 flex-1 overflow-hidden";
const META = "truncate text-xs text-grey-50 dark:text-grey-dark-600";
/** META's type, for a line that is an email or an address: `MiddleTruncate` shortens it. */
const META_TEXT = "text-xs text-grey-50 dark:text-grey-dark-600";
/** A pending invitation's address, the row's name line. */
const ADDRESS_TEXT = "text-sm text-grey-10 dark:text-white";
/** The right-hand slot: as wide as the role select, its contents at the right end. */
export const ROLE_SLOT = "flex w-[98px] shrink-0 items-center justify-end";
/** A role as plain text, ending where the column ends. */
export const ROLE_TEXT = "min-w-0 truncate text-right text-xs text-grey-50 dark:text-grey-dark-600";
/**
 * A quiet select's chevron sits inside the trigger's padding; pulled right by
 * that padding, the chevron ends flush with the plain-text roles.
 */
export const FLUSH_SELECT = "w-auto min-w-0 -mr-2.5";
/** A row's destructive action as red text, like the console's. */
export const DANGER_TEXT_BUTTON =
  "inline-flex h-8 shrink-0 items-center text-xs font-medium text-error-70 hover:underline dark:text-error-70";
const SMALL_BUTTON = "h-8 shrink-0 rounded-[6px] px-3 text-xs font-medium";

/** What a row is waiting on, while a change is on the wire. */
export type Busy = "saving" | "removing" | "revoking";

/**
 * Pessimistic row changes, shared by this section and the Manage access
 * panel: mark the row, run the command, read the list again, and only then
 * let the row show the result. A refusal leaves the row as it was, with the
 * reason under it. Other rows stay usable meanwhile.
 *
 * A refusal because the plan does not include sharing (403
 * `shared_drives_not_entitled`) goes to `onNotEntitled` instead, when the
 * host passes it, so the host shows its upgrade card rather than a row
 * error.
 */
export function useRowChanges(
  onChanged: () => void,
  reload: () => Promise<void>,
  onNotEntitled?: () => void,
) {
  const [busy, setBusy] = useState<Record<string, Busy>>({});
  const [rowError, setRowError] = useState<{ key: string; message: string } | null>(null);

  const run = useCallback(
    async (key: string, who: string, kind: Busy, action: () => Promise<unknown>) => {
      setBusy((b) => ({ ...b, [key]: kind }));
      setRowError((e) => (e?.key === key ? null : e));
      try {
        await action();
        onChanged();
        await reload();
      } catch (err) {
        if (onNotEntitled && isSharedDrivesNotEntitled(err)) {
          onNotEntitled();
        } else {
          setRowError({ key, message: couldNotChangeAccess(who, errorMessage(err)) });
        }
      } finally {
        setBusy((b) => {
          const next = { ...b };
          delete next[key];
          return next;
        });
      }
    },
    [onChanged, reload, onNotEntitled],
  );

  return { busy, rowError, run };
}

export function PeopleWithAccessSection({
  state,
  folder,
  label,
  target,
  ownerName,
  reload,
  retry,
  onChanged,
  onManage,
  canAddAccess = true,
  onNotEntitled,
}: {
  state: ShareAccessState;
  /** Present for a folder dialog. */
  folder: string | null;
  label: string;
  target?: DriveTarget;
  /** The owner's display name, when somebody else owns the drive. */
  ownerName?: string;
  reload: () => Promise<void>;
  retry: () => void;
  /** Something changed on the server: badges and the Links tab refresh. */
  onChanged: () => void;
  /**
   * Opens the manage panel for this drive; with "people", straight on its
   * full list of people (the "+N more" row, which is where that list went).
   */
  onManage: (openOn?: "people") => void;
  /**
   * False on a plan without sharing: approving a waiting invitation adds
   * someone, so Approve is not offered. Removing and cancelling still are.
   */
  canAddAccess?: boolean;
  /** A change was refused because the plan does not include sharing. */
  onNotEntitled?: () => void;
}) {
  const { busy, rowError, run } = useRowChanges(onChanged, reload, onNotEntitled);

  const access = state.kind === "ready" ? state.access : null;
  const count = access
    ? 1 + access.members.length + access.folderHolders.length + access.pendingInvites.length
    : null;

  const rows: Array<{ key: string; node: React.ReactNode }> = [];
  if (access) {
    rows.push({
      key: "owner",
      node: <OwnerRow ss58={access.ownerSs58} isYou={access.ownerIsYou} name={ownerName} />,
    });
    // The owner and a whole-drive Manager change access (Rust decides
    // `canManage`); everyone else sees every row read only.
    const readOnly = !access.canManage;
    // You first after the owner, then everyone else in the order Rust sent.
    const members = [...access.members].sort((a, b) => Number(b.isYou) - Number(a.isYou));
    for (const m of members) {
      const who = accountDisplayName(m.memberSs58, m.memberName);
      rows.push({
        key: m.memberSs58,
        node: (
          <MemberRow
            member={m}
            readOnly={readOnly}
            busy={busy[m.memberSs58]}
            onChangeRole={(role) =>
              void run(m.memberSs58, who, "saving", () => changeDriveMemberRole(label, m.memberSs58, role, target))
            }
            onRemove={() => void run(m.memberSs58, who, "removing", () => removeDriveMember(label, m.memberSs58, target))}
          />
        ),
      });
    }
    for (const h of access.folderHolders) {
      const who = accountDisplayName(h.memberSs58, h.memberName);
      rows.push({
        key: h.memberSs58,
        node: (
          <HolderRow
            holder={h}
            folder={folder ?? ""}
            readOnly={readOnly}
            busy={busy[h.memberSs58]}
            onRemove={() => void run(h.memberSs58, who, "removing", () => removeDriveMember(label, h.memberSs58, target))}
          />
        ),
      });
    }
    for (const i of access.pendingInvites) {
      const who = i.recipientEmail ?? "this invitation";
      rows.push({
        key: i.inviteId,
        node: (
          <PendingRow
            invite={i}
            busy={busy[i.inviteId]}
            onCancel={() => void run(i.inviteId, who, "removing", () => revokeDriveInvite(label, i.inviteId, target))}
            onApprove={
              canAddAccess
                ? () => void run(i.inviteId, who, "saving", () => approveEmailInvite(label, i.inviteId, target))
                : undefined
            }
          />
        ),
      });
    }
  }
  // Six rows at most; the rest live in the manage panel.
  const overflow = rows.length > PEOPLE_MAX_ROWS;
  const visible = overflow ? rows.slice(0, PEOPLE_MAX_ROWS - 1) : rows;
  const more = rows.length - visible.length;

  return (
    <section aria-labelledby="share-people-heading" className="@container">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 id="share-people-heading" className="text-sm font-medium text-grey-10 dark:text-white">
          People with access{" "}
          {count !== null ? <span className="text-grey-50 dark:text-grey-dark-600">({count})</span> : null}
        </h3>
        <button
          type="button"
          onClick={() => onManage()}
          className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary-50 hover:underline dark:text-primary-brand-dark"
        >
          Manage access
          <ArrowRight className="size-3.5" aria-hidden />
        </button>
      </div>

      {state.kind === "loading" ? <PeopleSkeleton /> : null}
      {state.kind === "unavailable" ? (
        <InlineNotice tone="info" className="mt-2">
          {SHARED_DRIVES_UNAVAILABLE_COPY}
        </InlineNotice>
      ) : null}
      {state.kind === "error" ? (
        <InlineNotice
          tone="error"
          className="mt-2"
          action={
            <Button type="button" variant="defaultStable" size="auto" onClick={retry} className={SMALL_BUTTON}>
              Try again
            </Button>
          }
        >
          {state.message}
        </InlineNotice>
      ) : null}

      {access ? (
        <RowConfirmProvider>
          <ul className="divide-y divide-grey-90 dark:divide-white/10">
            {visible.map((row) => (
              <li key={row.key}>
                {row.node}
                {rowError?.key === row.key ? (
                  <InlineNotice tone="error" className="mb-2">
                    {rowError.message}
                  </InlineNotice>
                ) : null}
              </li>
            ))}
            {more > 0 ? (
              <li>
                <button
                  type="button"
                  onClick={() => onManage("people")}
                  className={cn(ROW, "w-full text-left text-xs font-medium text-primary-50 hover:underline dark:text-primary-brand-dark")}
                >
                  <span
                    aria-hidden
                    className="flex size-8 shrink-0 items-center justify-center rounded-full bg-grey-90 text-grey-50 dark:bg-white/10 dark:text-grey-dark-600"
                  >
                    <Users className="size-4" />
                  </span>
                  +{more} more · Manage access
                </button>
              </li>
            ) : null}
          </ul>
        </RowConfirmProvider>
      ) : null}

      {access && folder !== null ? (
        <div className="mt-2 flex flex-col gap-1">
          {access.driveMemberCount > 0 ? (
            <p className="text-xs text-grey-50 dark:text-grey-dark-600">
              People with access to the whole drive can open this folder too.
            </p>
          ) : null}
          <p className="text-xs text-grey-50 dark:text-grey-dark-600">{FOLDER_ACCESS_HINT}</p>
        </div>
      ) : null}
    </section>
  );
}

const BUSY_WORD: Record<Busy, string> = {
  saving: "Saving…",
  removing: "Removing…",
  revoking: "Revoking…",
};

/** The small spinner and word a row shows while its change is on the wire. */
export function BusyLabel({ busy, className }: { busy: Busy; className?: string }) {
  return (
    <span
      role="status"
      className={cn("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-grey-50 dark:text-grey-dark-600", className)}
    >
      <Loader2 className="size-3.5 animate-spin" aria-hidden />
      {BUSY_WORD[busy]}
    </span>
  );
}

export function PersonAvatar({ ss58 }: { ss58: string }) {
  return (
    <div className="size-8 shrink-0 overflow-hidden rounded-full">
      <Avatar name={ss58} size={32} variant="marble" colors={["#92A1C6", "#146A7C", "#F0AB3D", "#C271B4", "#C20D90"]} />
    </div>
  );
}

export function OwnerRow({ ss58, isYou, name }: { ss58: string; isYou: boolean; name?: string }) {
  return (
    <div className={ROW}>
      <PersonAvatar ss58={ss58} />
      <div className={cn(TEXT_COLUMN, "flex items-baseline gap-1.5")}>
        <AccountLabel ss58={ss58} name={name} focusable className="text-sm text-grey-10 dark:text-white" />
        {isYou ? <span className="shrink-0 text-xs text-grey-50 dark:text-grey-dark-600">(you)</span> : null}
      </div>
      <span className={ROLE_SLOT}>
        <span className={ROLE_TEXT}>Owner</span>
      </span>
    </div>
  );
}

/** A row's own name line: the label, and "(you)" on your own row. */
function NameLine({ ss58, name, email, isYou }: { ss58: string; name?: string; email?: string; isYou?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <AccountLabel ss58={ss58} name={name} email={email} focusable className="text-sm text-grey-10 dark:text-white" />
      {isYou ? <span className="shrink-0 text-xs text-grey-50 dark:text-grey-dark-600">(you)</span> : null}
    </div>
  );
}

/** A row that can take focus back after its question, without a ring. */
const FOCUS_ROOT = "outline-none";

export function MemberRow({
  member,
  busy,
  onChangeRole,
  onRemove,
  readOnly = false,
  meta,
}: {
  member: ShareAccessMember;
  busy?: Busy;
  onChangeRole: (role: DriveRole) => void;
  onRemove: () => void;
  /** Someone who cannot manage the drive sees the role as text. */
  readOnly?: boolean;
  /** The line under the name; the email when omitted. */
  meta?: React.ReactNode;
}) {
  const role = parseDriveRole(member.role);
  const { asking, ask, cancel, done, rowRef } = useRowConfirm<"remove" | DriveRole>(member.memberSs58);
  const who = accountDisplayName(member.memberSs58, member.memberName);
  const metaLine = meta !== undefined ? meta : member.memberEmail;
  const name = (
    <NameLine ss58={member.memberSs58} name={member.memberName} email={member.memberEmail} isYou={member.isYou} />
  );

  const choose = (value: string) => {
    if (value === REMOVE) return ask("remove");
    const next = parseDriveRole(value);
    if (next === role) return;
    // A demotion revokes links as a side effect, so it is confirmed first; a
    // promotion takes nothing away and goes straight to the server.
    if (driveRoleDemotionWarning(role, next)) return ask(next);
    onChangeRole(next);
  };

  if (asking) {
    const removing = asking === "remove";
    return (
      <RowConfirm
        leading={<PersonAvatar ss58={member.memberSs58} />}
        title={name}
        question={removing ? `Remove ${who}'s access to this drive?` : `Make ${who} a ${driveRoleLabel(asking)}?`}
        detail={removing ? null : driveRoleDemotionWarning(role, asking)}
        confirmLabel={removing ? "Remove" : "Change role"}
        destructive={removing}
        onConfirm={() => {
          done();
          if (removing) onRemove();
          else onChangeRole(asking);
        }}
        onCancel={cancel}
      />
    );
  }

  return (
    <div
      ref={rowRef}
      tabIndex={-1}
      className={cn(ROW, FOCUS_ROOT, busy === "removing" && "opacity-60")}
      aria-busy={busy ? true : undefined}
    >
      <PersonAvatar ss58={member.memberSs58} />
      <div className={TEXT_COLUMN}>
        {name}
        {/* The email (the default line, and the panel's too) is shortened in
            the middle, keeping its domain; other lines are cut at the end. */}
        {metaLine && metaLine === member.memberEmail ? (
          <MiddleTruncate text={member.memberEmail} className={META_TEXT} />
        ) : metaLine ? (
          <p className={META} title={typeof metaLine === "string" ? metaLine : undefined}>
            {metaLine}
          </p>
        ) : null}
      </div>
      {/* A role change keeps the old role in view, disabled, until the server
          answers; the words sit left of the slot and the name gives way. */}
      {busy === "saving" ? <BusyLabel busy={busy} /> : null}
      <span className={ROLE_SLOT} {...ROW_TRIGGER}>
        {busy && busy !== "saving" ? (
          <BusyLabel busy={busy} className="pl-2.5" />
        ) : member.isYou || readOnly ? (
          // Nobody changes their own role; a member leaves instead.
          <span className={ROLE_TEXT}>{driveRoleLabel(role)}</span>
        ) : (
          <Select
            ariaLabel={`Role for ${who}`}
            value={role}
            onValueChange={choose}
            disabled={Boolean(busy)}
            size="compact"
            chrome="quiet"
            minimal
            options={[
              ...DRIVE_ROLES.map((r) => ({ label: driveRoleLabel(r), value: r, description: driveRoleDescription(r) })),
              { label: "Remove access", value: REMOVE },
            ]}
            className={FLUSH_SELECT}
            triggerClassName="w-auto max-w-[108px]"
          />
        )}
      </span>
    </div>
  );
}

/** Said under a removal when the person also holds other folders of the drive. */
export const OTHER_FOLDERS_LINE = "They also lose any other folders on this drive shared with them.";

function HolderRow({
  holder,
  folder,
  busy,
  onRemove,
  readOnly = false,
}: {
  holder: ShareAccessHolder;
  folder: string;
  busy?: Busy;
  onRemove: () => void;
  /** Someone who cannot manage the drive sees no Remove. */
  readOnly?: boolean;
}) {
  const { asking, ask, cancel, done, rowRef } = useRowConfirm<"remove">(holder.memberSs58);
  const who = accountDisplayName(holder.memberSs58, holder.memberName);
  const role = driveRoleLabel(parseDriveRole(holder.role));
  // Access that comes from a folder around this one says where from.
  const via = holder.pathPrefix !== folder ? `Through “${holder.pathPrefix}”` : null;
  const name = <NameLine ss58={holder.memberSs58} name={holder.memberName} email={holder.memberEmail} />;

  if (asking) {
    return (
      <RowConfirm
        leading={<PersonAvatar ss58={holder.memberSs58} />}
        title={name}
        // Removing takes away the grant they hold, which for access through
        // a folder around this one is that folder.
        question={`Remove ${who}'s access to ${via ? `“${holder.pathPrefix}”` : "this folder"}?`}
        detail={holder.otherFolderCount > 0 ? OTHER_FOLDERS_LINE : null}
        confirmLabel="Remove"
        onConfirm={() => {
          done();
          onRemove();
        }}
        onCancel={cancel}
      />
    );
  }

  return (
    <div
      ref={rowRef}
      tabIndex={-1}
      className={cn(ROW, FOCUS_ROOT, busy === "removing" && "opacity-60")}
      aria-busy={busy ? true : undefined}
    >
      <PersonAvatar ss58={holder.memberSs58} />
      <div className={TEXT_COLUMN}>
        {name}
        {holder.memberEmail || via ? (
          // The email gives way in the middle, keeping its domain; the folder
          // it comes through is cut at its end, after the email.
          <div
            className={cn("flex min-w-0 items-baseline", META_TEXT)}
            title={[holder.memberEmail, via].filter(Boolean).join(" · ")}
          >
            {holder.memberEmail ? <MiddleTruncate text={holder.memberEmail} title={null} /> : null}
            {via ? (
              <span className="min-w-[3rem] shrink-[4] truncate whitespace-pre">
                {holder.memberEmail ? " · " : ""}
                {via}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {/* The role in the column every row shares, then Remove, last, so the
          right edge lines up down the list. */}
      <span className={ROLE_SLOT}>
        {busy ? <BusyLabel busy={busy} className="pl-2.5" /> : <span className={ROLE_TEXT}>{role}</span>}
      </span>
      {busy || readOnly ? null : (
        <button
          type="button"
          onClick={() => ask("remove")}
          aria-label={`Remove ${who}`}
          className={DANGER_TEXT_BUTTON}
          {...ROW_TRIGGER}
        >
          Remove
        </button>
      )}
    </div>
  );
}

export function PendingRow({
  invite,
  busy,
  onCancel,
  onApprove,
  meta,
}: {
  invite: DriveInviteInfo;
  busy?: Busy;
  onCancel: () => void;
  /** Omitted when this account may not add people (a plan without sharing). */
  onApprove?: () => void;
  /**
   * The line under the address, in place of the dialog's stage and expiry
   * words (the Manage access panel draws a stage pill and a folder tag).
   */
  meta?: React.ReactNode;
}) {
  const { asking, ask, cancel, done, rowRef } = useRowConfirm<"cancel">(invite.inviteId);
  // Approval is the one step a mailed invitation needs from this side: the
  // recipient opened it, and approving seals the drive key to them.
  const needsApproval = invite.emailStatus === "awaiting_seal";
  const address = invite.recipientEmail ?? "Address no longer on file";
  const icon = (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-grey-90 text-grey-50 dark:bg-white/10 dark:text-grey-dark-600"
    >
      <Mail className="size-4" />
    </span>
  );

  if (asking) {
    return (
      <RowConfirm
        leading={icon}
        title={<MiddleTruncate text={address} className={ADDRESS_TEXT} />}
        question="Cancel this invite?"
        detail="The link in the email stops working."
        confirmLabel="Cancel invite"
        onConfirm={() => {
          done();
          onCancel();
        }}
        onCancel={cancel}
      />
    );
  }

  return (
    // Wraps on a narrow dialog: the address keeps room to be read and the
    // buttons move, together, to a second line.
    <div
      ref={rowRef}
      tabIndex={-1}
      className={cn(ROW, FOCUS_ROOT, "flex-wrap gap-y-1.5", busy === "removing" && "opacity-60")}
      aria-busy={busy ? true : undefined}
    >
      {icon}
      <div className="min-w-0 flex-1 basis-[150px] overflow-hidden">
        <MiddleTruncate text={address} className={ADDRESS_TEXT} />
        {meta !== undefined ? (
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-grey-50 dark:text-grey-dark-600">
            {meta}
          </div>
        ) : (
          <p className={cn(META, needsApproval && "text-warning-50 dark:text-warning-50")} title={pendingInviteMeta(invite)}>
            {pendingInviteMeta(invite)}
            <span className="@sm:hidden"> · {driveRoleLabel(parseDriveRole(invite.role))}</span>
          </p>
        )}
      </div>
      {meta !== undefined ? null : (
        <span className={cn(ROLE_TEXT, "hidden @sm:inline")}>{driveRoleLabel(parseDriveRole(invite.role))}</span>
      )}
      {busy ? (
        <BusyLabel busy={busy} />
      ) : (
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {needsApproval && onApprove ? (
            <Button type="button" variant="primary" size="auto" onClick={onApprove} className={SMALL_BUTTON}>
              Approve
            </Button>
          ) : null}
          <Button
            type="button"
            variant="defaultStable"
            size="auto"
            onClick={() => ask("cancel")}
            aria-label={`Cancel invite to ${address}`}
            className={SMALL_BUTTON}
            {...ROW_TRIGGER}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

/** Rows shaped like the real ones, so the list does not jump when it lands. */
export function PeopleSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading people with access">
      <span className="sr-only">Loading people with access…</span>
      {[112, 144, 96].map((w, i) => (
        <div key={i} className={ROW}>
          <Skeleton variant="circle" width={32} height={32} />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton width={w} height={12} className="rounded-md" />
            <Skeleton width={w - 30} height={10} className="rounded-md" />
          </div>
          <Skeleton width={72} height={28} className="shrink-0 rounded-md" />
        </div>
      ))}
    </div>
  );
}
