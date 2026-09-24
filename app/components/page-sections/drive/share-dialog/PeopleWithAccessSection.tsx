"use client";

// "People with access": the owner, you, then everyone else in the drive (or
// holding the folder), then emailed invitations still waiting. Who belongs
// here is decided in Rust (`list_share_access`); this section only draws the
// rows and sends each change through the existing commands.
//
// Changes are pessimistic: the row says "Saving…" or "Removing…" until the
// command has succeeded AND the listing has been read again, and a refusal
// leaves the row as it was with the reason under it. Other rows stay usable
// meanwhile. A demotion asks first, because the server also revokes links as
// part of it. A folder holder has no role change (HCFS #475): the row offers
// Remove and the list says to invite them again.

import React, { useCallback, useState } from "react";
import dynamic from "next/dynamic";
import { ArrowRight, Loader2, Mail, Users } from "lucide-react";

import { Button, Icons, Skeleton } from "@/components/ui";
import { Select } from "@/components/ui/select/Select";
import ConfirmationDialog from "@/components/ConfirmationDialog";
import AccountLabel from "../AccountLabel";
import { cn } from "@/lib/utils";
import type {
  DriveInviteInfo,
  DriveTarget,
  ShareAccessHolder,
  ShareAccessMember,
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
import {
  FOLDER_ACCESS_HINT,
  PEOPLE_MAX_ROWS,
  SHARED_DRIVES_UNAVAILABLE_COPY,
  couldNotChangeAccess,
  pendingInviteMeta,
} from "./shareDialogState";
import type { ShareAccessApi } from "./shareAccessApi";
import type { ShareAccessState } from "./useShareAccess";

const Avatar = dynamic(() => import("boring-avatars"), { ssr: false });

/** The value the row's select uses for "Remove access". Never a role. */
const REMOVE = "remove";

const ROW = "flex min-h-[48px] items-center gap-3 py-2";
const META = "truncate text-xs text-grey-50 dark:text-grey-dark-600";
const ROLE_TEXT = "shrink-0 text-xs text-grey-50 dark:text-grey-dark-600";
const SMALL_BUTTON = "h-8 shrink-0 rounded-[6px] px-3 text-xs font-medium";

/** What a row is waiting on, while a change is on the wire. */
export type Busy = "saving" | "removing" | "revoking";

/**
 * Pessimistic row changes, shared by this section and the Manage access
 * panel: mark the row, run the command, read the list again, and only then
 * let the row show the result. A refusal leaves the row as it was, with the
 * reason under it. Other rows stay usable meanwhile.
 */
export function useRowChanges(onChanged: () => void, reload: () => Promise<void>) {
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
        setRowError({ key, message: couldNotChangeAccess(who, errorMessage(err)) });
      } finally {
        setBusy((b) => {
          const next = { ...b };
          delete next[key];
          return next;
        });
      }
    },
    [onChanged, reload],
  );

  return { busy, rowError, run };
}

export function PeopleWithAccessSection({
  api,
  state,
  folder,
  label,
  target,
  ownerName,
  reload,
  retry,
  onChanged,
  onManage,
}: {
  api: ShareAccessApi;
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
  /** Opens the manage panel for this drive. */
  onManage: () => void;
}) {
  const { busy, rowError, run } = useRowChanges(onChanged, reload);

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
    // You first after the owner, then everyone else in the order Rust sent.
    const members = [...access.members].sort((a, b) => Number(b.isYou) - Number(a.isYou));
    for (const m of members) {
      const who = accountDisplayName(m.memberSs58, m.memberName);
      rows.push({
        key: m.memberSs58,
        node: (
          <MemberRow
            member={m}
            busy={busy[m.memberSs58]}
            onChangeRole={(role) =>
              void run(m.memberSs58, who, "saving", () => api.changeRole(label, m.memberSs58, role, target))
            }
            onRemove={() => void run(m.memberSs58, who, "removing", () => api.remove(label, m.memberSs58, target))}
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
            busy={busy[h.memberSs58]}
            onRemove={() => void run(h.memberSs58, who, "removing", () => api.remove(label, h.memberSs58, target))}
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
            onCancel={() => void run(i.inviteId, who, "removing", () => api.revoke(label, i.inviteId, target))}
            onApprove={() => void run(i.inviteId, who, "saving", () => api.approve(label, i.inviteId, target))}
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
          onClick={onManage}
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
                onClick={onManage}
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
export function BusyLabel({ busy }: { busy: Busy }) {
  return (
    <span role="status" className="inline-flex shrink-0 items-center gap-1.5 text-xs text-grey-50 dark:text-grey-dark-600">
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
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <AccountLabel ss58={ss58} name={name} className="text-sm text-grey-10 dark:text-white" />
        {isYou ? <span className="shrink-0 text-xs text-grey-50 dark:text-grey-dark-600">(you)</span> : null}
      </div>
      <span className={ROLE_TEXT}>Owner</span>
    </div>
  );
}

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
  const [pending, setPending] = useState<"none" | "remove" | DriveRole>("none");
  const who = accountDisplayName(member.memberSs58, member.memberName);
  const demotion = pending !== "none" && pending !== "remove" ? driveRoleDemotionWarning(role, pending) : null;

  const choose = (value: string) => {
    if (value === REMOVE) return setPending("remove");
    const next = parseDriveRole(value);
    if (next === role) return;
    // A demotion revokes links as a side effect, so it is confirmed first; a
    // promotion takes nothing away and goes straight to the server.
    if (driveRoleDemotionWarning(role, next)) return setPending(next);
    onChangeRole(next);
  };

  return (
    <div className={cn(ROW, busy === "removing" && "opacity-60")} aria-busy={busy ? true : undefined}>
      <PersonAvatar ss58={member.memberSs58} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <AccountLabel
            ss58={member.memberSs58}
            name={member.memberName}
            email={member.memberEmail}
            className="text-sm text-grey-10 dark:text-white"
          />
          {member.isYou ? <span className="shrink-0 text-xs text-grey-50 dark:text-grey-dark-600">(you)</span> : null}
        </div>
        {meta !== undefined ? (
          meta ? <p className={META}>{meta}</p> : null
        ) : member.memberEmail ? (
          <p className={META}>{member.memberEmail}</p>
        ) : null}
      </div>
      {busy ? <BusyLabel busy={busy} /> : null}
      {member.isYou || readOnly ? (
        // Nobody changes their own role; a manager leaves instead.
        <span className={ROLE_TEXT}>{driveRoleLabel(role)}</span>
      ) : busy === "removing" ? null : (
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
          className="w-auto shrink-0"
          triggerClassName="w-[98px]"
        />
      )}

      <ConfirmationDialog
        open={pending === "remove"}
        onClose={() => setPending("none")}
        onBack={() => setPending("none")}
        onConfirm={() => {
          setPending("none");
          onRemove();
        }}
        heading="Remove access"
        icon={<Icons.Trash className="size-4 text-white" />}
        iconBgColor="bg-[#fc7d73]"
        confirmVariant="destructive"
        confirmButtonClassName="text-white"
        button="Remove"
        text={`Remove ${who} from this drive?`}
        helperText="They lose access on their next request. Files already on their device stay there."
      />
      <ConfirmationDialog
        open={demotion !== null}
        onClose={() => setPending("none")}
        onBack={() => setPending("none")}
        onConfirm={() => {
          if (pending !== "none" && pending !== "remove") onChangeRole(pending);
          setPending("none");
        }}
        heading="Change role"
        icon={<Icons.InfoCircle className="size-4 text-white" />}
        button="Change role"
        text={pending !== "none" && pending !== "remove" ? `Make ${who} a ${driveRoleLabel(pending)}?` : ""}
        helperText={demotion ?? undefined}
      />
    </div>
  );
}

function HolderRow({
  holder,
  folder,
  busy,
  onRemove,
}: {
  holder: ShareAccessHolder;
  folder: string;
  busy?: Busy;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const who = accountDisplayName(holder.memberSs58, holder.memberName);
  const role = driveRoleLabel(parseDriveRole(holder.role));
  // Access that comes from a folder around this one says where from.
  const via = holder.pathPrefix !== folder ? `Through “${holder.pathPrefix}”` : null;
  const others = holder.otherFolderCount;

  return (
    <div className={cn(ROW, busy === "removing" && "opacity-60")} aria-busy={busy ? true : undefined}>
      <PersonAvatar ss58={holder.memberSs58} />
      <div className="min-w-0 flex-1">
        <AccountLabel
          ss58={holder.memberSs58}
          name={holder.memberName}
          email={holder.memberEmail}
          className="text-sm text-grey-10 dark:text-white"
        />
        {holder.memberEmail || via ? (
          <p className={META}>{[holder.memberEmail, via].filter(Boolean).join(" · ")}</p>
        ) : null}
      </div>
      <span className={ROLE_TEXT}>{role}</span>
      {busy ? (
        <BusyLabel busy={busy} />
      ) : (
        <Button
          type="button"
          variant="defaultStable"
          size="auto"
          onClick={() => setConfirming(true)}
          aria-label={`Remove ${who}`}
          className={SMALL_BUTTON}
        >
          Remove
        </Button>
      )}
      <ConfirmationDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onBack={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          onRemove();
        }}
        heading="Remove folder access"
        icon={<Icons.Trash className="size-4 text-white" />}
        iconBgColor="bg-[#fc7d73]"
        confirmVariant="destructive"
        confirmButtonClassName="text-white"
        button="Remove"
        text={`Remove ${who}'s access to “${holder.pathPrefix}”?`}
        helperText={
          others > 0
            ? `This also removes their access to ${others} other folder${others === 1 ? "" : "s"} on this drive. Files already on their device stay there.`
            : "They lose access on their next request. Files already on their device stay there."
        }
      />
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
  onApprove: () => void;
  /**
   * The line under the address, in place of the dialog's stage and expiry
   * words (the Manage access panel draws a stage pill and a folder tag).
   */
  meta?: React.ReactNode;
}) {
  // Approval is the one step a mailed invitation needs from this side: the
  // recipient opened it, and approving seals the drive key to them.
  const needsApproval = invite.emailStatus === "awaiting_seal";
  const address = invite.recipientEmail ?? "Address no longer on file";

  return (
    // Wraps on a narrow dialog: the address keeps room to be read and the
    // buttons move, together, to a second line.
    <div
      className={cn(ROW, "flex-wrap gap-y-1.5", busy === "removing" && "opacity-60")}
      aria-busy={busy ? true : undefined}
    >
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-grey-90 text-grey-50 dark:bg-white/10 dark:text-grey-dark-600"
      >
        <Mail className="size-4" />
      </span>
      <div className="min-w-0 flex-1 basis-[150px]">
        <p className="truncate text-sm text-grey-10 dark:text-white" title={address}>
          {address}
        </p>
        {meta !== undefined ? (
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-grey-50 dark:text-grey-dark-600">
            {meta}
          </div>
        ) : (
          <p className={cn(META, needsApproval && "text-warning-50 dark:text-warning-50")}>
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
          {needsApproval ? (
            <Button type="button" variant="primary" size="auto" onClick={onApprove} className={SMALL_BUTTON}>
              Approve
            </Button>
          ) : null}
          <Button
            type="button"
            variant="defaultStable"
            size="auto"
            onClick={onCancel}
            aria-label={`Cancel invite to ${address}`}
            className={SMALL_BUTTON}
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
