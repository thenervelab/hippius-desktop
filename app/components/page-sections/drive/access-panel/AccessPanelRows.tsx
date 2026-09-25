"use client";

// The Manage access panel's own rows: folder holders, links, and the small
// pieces around the groups. Member, owner and pending-invite rows are the
// Share dialog's (`share-dialog/PeopleWithAccessSection`), reused as they are.

import React, { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, ChevronDown, Clock, Folder, FolderPen, Link2, Lock, Plus, Users } from "lucide-react";
import { toast } from "sonner";

import { Button, Icons, Skeleton } from "@/components/ui";
import ConfirmationDialog from "@/components/ConfirmationDialog";
import TableActionMenu from "@/components/ui/alt-table/TableActionMenu";
import { cn } from "@/lib/utils";
import AccountLabel from "../AccountLabel";
import {
  BusyLabel,
  PersonAvatar,
  ROLE_SLOT,
  ROLE_TEXT,
  ROW,
  TEXT_COLUMN,
  type Busy,
} from "../share-dialog/PeopleWithAccessSection";
import ChangeFoldersDialog, { type FolderRole } from "./ChangeFoldersDialog";
import type { AccessPanelHolder, AccessPanelLink } from "@/app/lib/tauri/sharedDrives";
import { accountDisplayName } from "@/app/lib/shared-drives/accountLabel";
import { driveRoleLabel, parseDriveRole } from "@/app/lib/shared-drives/roles";
import { truncateInviteUrl } from "@/app/lib/shared-drives/inviteLink";
import {
  ACCESS_PANEL_COPY,
  PANEL_PREVIEW,
  capRows,
  endedLinksLine,
  holderFolderTag,
  linkCreator,
  linkEndedLabel,
  linkMeta,
  linkTitle,
  linkUsage,
  showAllLabel,
  type PanelGroup,
} from "./accessPanelView";

export const PANEL_ROW = ROW;
const MUTED = "text-xs text-grey-50 dark:text-grey-dark-600";
const ICON_TILE =
  "flex size-8 shrink-0 items-center justify-center rounded-[9px] border border-grey-80 bg-grey-90/60 text-grey-50 dark:border-white/10 dark:bg-white/5 dark:text-grey-dark-600";
const MENU_BUTTON =
  "h-7 w-7 shrink-0 rounded-md p-0 text-grey-70 transition-colors hover:bg-grey-90 hover:text-grey-30 dark:text-grey-dark-600 dark:hover:bg-white/10 dark:hover:text-white";

/** A group's heading: its name, a count, and one small action on the right. */
export function GroupHeader({
  id,
  title,
  count,
  action,
  highlighted = false,
}: {
  id: string;
  title: string;
  count?: React.ReactNode;
  action?: { label: string; onClick: () => void };
  /** Briefly marked after the jump bar scrolled here, so the eye lands on it. */
  highlighted?: boolean;
}) {
  return (
    <div
      data-highlighted={highlighted || undefined}
      className={cn(
        "-mx-1.5 mt-3 flex items-center justify-between gap-2 rounded-md px-1.5 pb-1 pt-1 transition-colors duration-500",
        highlighted && "bg-primary-50/10 dark:bg-primary-brand-dark/15",
      )}
    >
      <h3
        id={id}
        // A jump from the bar moves focus here, so a keyboard or screen
        // reader user lands where the eye does.
        tabIndex={-1}
        className="min-w-0 truncate text-xs font-semibold uppercase tracking-[0.04em] text-grey-50 outline-none dark:text-grey-dark-600"
      >
        {title}
        {count !== undefined ? <span className="ml-1.5 font-medium">{count}</span> : null}
      </h3>
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1 text-xs font-medium text-primary-50 hover:underline dark:text-primary-brand-dark"
        >
          <Plus className="size-3.5" aria-hidden />
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

/** The small dashed tag naming the folder a row is about; a long path is cut short. */
export function FolderTag({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title ?? (typeof children === "string" ? children : undefined)}
      className="inline-flex min-w-0 max-w-[65%] shrink-0 items-center gap-1 rounded-md border border-dashed border-grey-80 px-1.5 text-[11px] leading-[18px] text-grey-50 dark:border-white/15 dark:text-grey-dark-600"
    >
      <Folder className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{children}</span>
    </span>
  );
}

/** A folder holder: tagged with their folder, role as text, and a menu. */
export function HolderRow({
  holder,
  busy,
  canManage,
  onRemove,
  onChangeFolders,
}: {
  holder: AccessPanelHolder;
  busy?: Busy;
  canManage: boolean;
  onRemove: () => void;
  onChangeFolders: (next: string[], addRole?: FolderRole) => Promise<void>;
}) {
  const [dialog, setDialog] = useState<"none" | "folders" | "remove">("none");
  const who = accountDisplayName(holder.memberSs58, holder.memberName);
  const folders = holder.folders;

  return (
    <div className={cn(PANEL_ROW, busy === "removing" && "opacity-60")} aria-busy={busy ? true : undefined}>
      <PersonAvatar ss58={holder.memberSs58} />
      <div className={TEXT_COLUMN}>
        <div className="flex min-w-0 items-baseline gap-1.5">
          <AccountLabel
            ss58={holder.memberSs58}
            name={holder.memberName}
            email={holder.memberEmail}
            focusable
            className="text-sm text-grey-10 dark:text-white"
          />
          {holder.isYou ? <span className="shrink-0 text-xs text-grey-50 dark:text-grey-dark-600">(you)</span> : null}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
          <FolderTag title={folders.join(", ")}>{holderFolderTag(holder)}</FolderTag>
          {holder.memberEmail ? (
            <span className={cn(MUTED, "min-w-0 truncate")} title={holder.memberEmail}>
              {holder.memberEmail}
            </span>
          ) : null}
        </div>
      </div>
      {/* The role and its menu share the members' role slot, so the role
          words line up with theirs down the list. */}
      <span className={ROLE_SLOT}>
        {busy ? (
          <BusyLabel busy={busy} className="pl-2.5" />
        ) : (
          <span className={ROLE_TEXT}>{driveRoleLabel(parseDriveRole(holder.role))}</span>
        )}
        {canManage && !busy && !holder.isYou ? (
          <TableActionMenu
            dropdownTitle=""
            items={[
              {
                icon: <FolderPen className="size-4" />,
                itemTitle: "Change folders",
                onItemClick: () => setDialog("folders"),
              },
              {
                icon: <Icons.Trash className="size-4" />,
                itemTitle: "Remove access",
                variant: "destructive",
                onItemClick: () => setDialog("remove"),
              },
            ]}
          >
            <Button variant="ghost" size="auto" aria-label={`Actions for ${who}`} className={MENU_BUTTON}>
              <Icons.EllipsisVertical className="size-[18px]" />
            </Button>
          </TableActionMenu>
        ) : null}
      </span>

      {dialog === "folders" ? (
        <ChangeFoldersDialog who={who} folders={folders} onClose={() => setDialog("none")} onConfirm={onChangeFolders} />
      ) : null}
      <ConfirmationDialog
        open={dialog === "remove"}
        onClose={() => setDialog("none")}
        onBack={() => setDialog("none")}
        onConfirm={() => {
          setDialog("none");
          onRemove();
        }}
        heading="Remove folder access"
        icon={<Icons.Trash className="size-4 text-white" />}
        iconBgColor="bg-[#fc7d73]"
        confirmVariant="destructive"
        confirmButtonClassName="text-white"
        button="Remove"
        text={`Remove ${who}'s access to ${folders.length === 1 ? `“${folders[0]}”` : "these folders"}?`}
        helperText="They lose folder access on their next request. Files already on their device stay there."
      />
    </div>
  );
}

const COPIED_MS = 1500;

/** The link as the field shows it: no scheme, and never the key after `#`. */
function displayInviteUrl(url: string): string {
  return truncateInviteUrl(url).replace(/^https?:\/\//, "");
}
const LOCKED_PLACEHOLDER = "console.hippius.com/invite/Xk29fLpQ7rTnB4vW8yHc";
const LINK_FIELD =
  "flex h-[34px] min-w-0 items-center gap-1.5 rounded-[8px] border border-grey-80 bg-white py-0 pl-2.5 pr-1 dark:border-white/10 dark:bg-[#1f1f1f]";
const FIELD_BUTTON = "h-[26px] shrink-0 gap-1 rounded-[6px] px-2 text-xs font-medium";

/**
 * Copying a link: writes the full link (key included) to the clipboard, says
 * so without ever quoting it, and marks the button "copied" for a moment.
 */
function useCopyInvite(url: string | undefined) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      // Never the URL itself in a toast: it carries the drive key.
      toast.success("Invite link copied");
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      toast.error("Couldn't copy invite link");
    }
  };
  return { copied, copy };
}

/**
 * A link's field: the address with the key after `#` hidden, and Copy for
 * the full link. Locked while the drive key is not available here, with a
 * way to unlock; a link whose sealed copy did not open says so.
 */
function LinkField({
  url,
  locked,
  onUnlock,
  unlocking,
}: {
  url?: string;
  locked: boolean;
  onUnlock: () => void;
  unlocking: boolean;
}) {
  const { copied, copy } = useCopyInvite(url);

  if (url) {
    return (
      <div className={LINK_FIELD}>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-grey-30 dark:text-grey-dark-500"
          title="Invite link (key hidden)"
        >
          {displayInviteUrl(url)}
        </span>
        <Button
          type="button"
          variant="defaultStable"
          size="auto"
          aria-label={copied ? "Copied" : "Copy invite link"}
          onClick={() => void copy()}
          className={FIELD_BUTTON}
        >
          {copied ? <Check className="size-3.5" aria-hidden /> : <Icons.Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    );
  }

  return (
    <div className={LINK_FIELD} role="status" aria-label="Link locked">
      <span aria-hidden className="min-w-0 flex-1 select-none truncate font-mono text-[11px] text-grey-30 blur-[3.5px] dark:text-grey-dark-500">
        {LOCKED_PLACEHOLDER}
      </span>
      {locked ? (
        <Button
          type="button"
          variant="defaultStable"
          size="auto"
          disabled={unlocking}
          onClick={onUnlock}
          className={FIELD_BUTTON}
        >
          <Lock className="size-3.5" aria-hidden />
          Unlock
        </Button>
      ) : (
        <span title="Could not rebuild this invite link" className="px-1.5">
          <Lock aria-hidden className="size-3.5 text-grey-50 dark:text-grey-dark-700" />
        </span>
      )}
    </div>
  );
}

type LinkRowProps = {
  link: AccessPanelLink;
  busy?: Busy;
  locked: boolean;
  unlocking: boolean;
  onUnlock: () => void;
  onRevoke: () => void;
};

/** A link's ⋯ menu with Revoke, confirmed first. Both link row shapes use it. */
function LinkRevokeMenu({ title, onRevoke }: { title: string; onRevoke: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <TableActionMenu
        dropdownTitle=""
        items={[
          {
            icon: <Icons.Trash className="size-4" />,
            itemTitle: "Revoke",
            variant: "destructive",
            onItemClick: () => setConfirming(true),
          },
        ]}
      >
        <Button variant="ghost" size="auto" aria-label={`Actions for ${title}`} className={MENU_BUTTON}>
          <Icons.EllipsisVertical className="size-[18px]" />
        </Button>
      </TableActionMenu>
      <ConfirmationDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onBack={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          onRevoke();
        }}
        heading="Revoke link"
        icon={<Icons.Trash className="size-4 text-white" />}
        iconBgColor="bg-[#fc7d73]"
        confirmVariant="destructive"
        confirmButtonClassName="text-white"
        button="Revoke"
        text={`Revoke this ${title.toLowerCase()}?`}
        helperText="Nobody new can join with it. People who already joined keep their access."
      />
    </>
  );
}

/** How far a multi-use link's uses have gone, as a bar. */
function UsageBar({ link, className }: { link: AccessPanelLink; className: string }) {
  return (
    <div
      role="progressbar"
      aria-label={linkUsage(link)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={link.usagePercent}
      className={cn("overflow-hidden rounded-full bg-grey-90 dark:bg-white/10", className)}
    >
      <span
        className="block h-full rounded-full bg-primary-50 dark:bg-primary-brand-dark"
        style={{ width: `${link.usagePercent}%` }}
      />
    </div>
  );
}

/** One working link: who it makes people, who made it, how used, the link. */
export function LinkRow({ link, busy, locked, unlocking, onUnlock, onRevoke }: LinkRowProps) {
  const creator = linkCreator(link);
  const title = linkTitle(link);

  return (
    <div className={cn("flex min-w-0 items-start gap-3 py-2", busy && "opacity-60")} aria-busy={busy ? true : undefined}>
      <span aria-hidden className={ICON_TILE}>
        <Link2 className="size-4" />
      </span>
      <div className="grid min-w-0 flex-1 gap-1.5 overflow-hidden">
        <div className="min-w-0">
          <p className="truncate text-sm text-grey-10 dark:text-white" title={creator ? `${title} · by ${creator}` : title}>
            {title}
            {creator ? <span className="text-xs text-grey-50 dark:text-grey-dark-600"> · by {creator}</span> : null}
          </p>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
            {link.pathPrefix ? <FolderTag>{link.pathPrefix}</FolderTag> : null}
            <span className={cn(MUTED, "min-w-0 truncate")} title={linkMeta(link)}>
              {linkMeta(link)}
            </span>
          </div>
        </div>
        {link.singleUse ? null : <UsageBar link={link} className="h-1" />}
        {link.linkAvailable ? (
          <LinkField url={link.inviteUrl} locked={locked} onUnlock={onUnlock} unlocking={unlocking} />
        ) : null}
      </div>
      {busy ? <BusyLabel busy={busy} /> : <LinkRevokeMenu title={title} onRevoke={onRevoke} />}
    </div>
  );
}

const ICON_BUTTON =
  "flex size-7 shrink-0 items-center justify-center rounded-md p-0 text-grey-40 transition-colors hover:bg-grey-90 hover:text-grey-10 disabled:opacity-50 dark:text-grey-dark-500 dark:hover:bg-white/10 dark:hover:text-white";

/**
 * The compact link row's one action: Copy while the link is here, Unlock
 * while links are locked, a quiet lock when the sealed copy did not open,
 * and an empty slot for a link with nothing to copy. Always the same width,
 * so the ⋯ menus line up down the group.
 */
function CompactLinkAction({
  link,
  locked,
  unlocking,
  onUnlock,
}: Pick<LinkRowProps, "link" | "locked" | "unlocking" | "onUnlock">) {
  const { copied, copy } = useCopyInvite(link.inviteUrl);
  if (!link.linkAvailable) return <span aria-hidden className="size-7 shrink-0" />;
  if (link.inviteUrl) {
    return (
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy link"}
        title={copied ? "Copied" : "Copy link"}
        onClick={() => void copy()}
        className={cn(ICON_BUTTON, copied && "text-success-40 dark:text-success-50")}
      >
        {copied ? <Check className="size-4" aria-hidden /> : <Icons.Copy className="size-4" />}
      </button>
    );
  }
  if (locked) {
    return (
      <button
        type="button"
        aria-label="Unlock to copy"
        title="Unlock to copy"
        disabled={unlocking}
        onClick={onUnlock}
        className={ICON_BUTTON}
      >
        <Lock className="size-4" aria-hidden />
      </button>
    );
  }
  return (
    <span title="Could not rebuild this invite link" className="flex size-7 shrink-0 items-center justify-center">
      <Lock aria-label="Could not rebuild this invite link" className="size-3.5 text-grey-50 dark:text-grey-dark-700" />
    </span>
  );
}

/** The compact row's right-hand slot: as wide as a person's role, so the columns line up. */
const LINK_ACTION_SLOT = "flex w-[98px] shrink-0 items-center justify-end gap-0.5";

/**
 * A working link in the main view, about as tall as a person's row: what it
 * makes people and who made it, how used and when it ends, a thin usage bar,
 * and Copy (or Unlock) beside the menu. The link itself is left to the Links
 * full view, which has the room for it.
 */
export function CompactLinkRow({ link, busy, locked, unlocking, onUnlock, onRevoke }: LinkRowProps) {
  const creator = linkCreator(link);
  const title = linkTitle(link);
  const heading = creator ? `${title} · by ${creator}` : title;
  const meta = linkMeta(link);

  return (
    <div className={cn(PANEL_ROW, busy && "opacity-60")} aria-busy={busy ? true : undefined}>
      <span aria-hidden className={ICON_TILE}>
        <Link2 className="size-4" />
      </span>
      <div className={TEXT_COLUMN}>
        <p className="truncate text-sm text-grey-10 dark:text-white" title={heading}>
          {title}
          {creator ? <span className="text-xs text-grey-50 dark:text-grey-dark-600"> · by {creator}</span> : null}
        </p>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
          {link.pathPrefix ? <FolderTag>{link.pathPrefix}</FolderTag> : null}
          <span className={cn(MUTED, "min-w-0 truncate")} title={meta}>
            {meta}
          </span>
        </div>
        {link.singleUse ? null : <UsageBar link={link} className="mt-1 h-[2px] w-full" />}
      </div>
      <span className={LINK_ACTION_SLOT}>
        {busy ? (
          <BusyLabel busy={busy} />
        ) : (
          <>
            <CompactLinkAction link={link} locked={locked} unlocking={unlocking} onUnlock={onUnlock} />
            <LinkRevokeMenu title={title} onRevoke={onRevoke} />
          </>
        )}
      </span>
    </div>
  );
}

/** A link that no longer works: what it was, and why it stopped. */
export function EndedLinkRow({ link }: { link: AccessPanelLink }) {
  return (
    <div className="flex min-w-0 items-center gap-3 py-2 opacity-80">
      <span aria-hidden className={ICON_TILE}>
        <Link2 className="size-4" />
      </span>
      <div className={TEXT_COLUMN}>
        <p className="truncate text-sm text-grey-30 dark:text-grey-dark-700">{linkTitle(link)}</p>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
          {link.pathPrefix ? <FolderTag>{link.pathPrefix}</FolderTag> : null}
          <span className={cn(MUTED, "min-w-0 truncate")} title={`${linkEndedLabel(link.status)} · ${linkUsage(link)}`}>
            {linkEndedLabel(link.status)} · {linkUsage(link)}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Links that no longer work, folded into one line until opened. Opened, it
 * shows the first few; the rest are in the Links full view's Ended list.
 */
export function EndedLinks({ links, onShowAll }: { links: AccessPanelLink[]; onShowAll: () => void }) {
  const [open, setOpen] = useState(false);
  if (links.length === 0) return null;
  const { shown, hidden } = capRows(links, false, PANEL_PREVIEW.links);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-lg px-1.5 py-2 text-left text-xs text-grey-50 transition-colors hover:bg-grey-90/60 dark:text-grey-dark-600 dark:hover:bg-white/5"
      >
        <span className="inline-flex items-center gap-1.5">
          <Clock className="size-3.5" aria-hidden />
          {endedLinksLine(links.length)}
        </span>
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open ? (
        <>
          <ul>
            {shown.map((l) => (
              <li key={l.inviteId}>
                <EndedLinkRow link={l} />
              </li>
            ))}
          </ul>
          {hidden > 0 ? (
            <ShowAllButton label={`Show all ${links.length} ended links`} onClick={onShowAll} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Under a group's first rows: opens the group's full view. */
export function ShowAllButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-2 text-left text-xs font-medium text-primary-50 transition-colors hover:bg-grey-90/60 dark:text-primary-brand-dark dark:hover:bg-white/5"
    >
      <span className="min-w-0 truncate">{label}</span>
      <ArrowRight className="size-3.5 shrink-0" aria-hidden />
    </button>
  );
}

/** "Show all 82 people →" under a group in the main view. */
export function ShowAllGroup({ group, total, onClick }: { group: PanelGroup; total: number; onClick: () => void }) {
  return <ShowAllButton label={showAllLabel(group, total)} onClick={onClick} />;
}

/** Only the owner has access: say so, and offer the Share dialog. */
export function EmptyAccess({ folder, onShare }: { folder: boolean; onShare: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 px-2 py-7 text-center">
      <span
        aria-hidden
        className="flex size-11 items-center justify-center rounded-xl bg-primary-50/10 text-primary-50 dark:bg-primary-50/15 dark:text-primary-brand-dark"
      >
        <Users className="size-5" />
      </span>
      <p className="text-sm font-medium text-grey-10 dark:text-white">{ACCESS_PANEL_COPY.emptyTitle}</p>
      <p className={cn(MUTED, "max-w-[260px]")}>{ACCESS_PANEL_COPY.emptyBody(folder)}</p>
      <Button
        type="button"
        variant="primary"
        size="auto"
        onClick={onShare}
        className="mt-1 h-[34px] gap-1.5 rounded-[8px] px-4 text-[13px] font-medium"
      >
        <Icons.Link className="size-3.5" />
        Share
      </Button>
    </div>
  );
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={PANEL_ROW}>
          <Skeleton variant="circle" width={32} height={32} />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton width={`${50 + ((i * 11) % 30)}%`} height={11} className="rounded-md" />
            <Skeleton width={`${35 + ((i * 7) % 25)}%`} height={9} className="rounded-md" />
          </div>
          <Skeleton width={54} height={22} className="shrink-0 rounded-md" />
        </div>
      ))}
    </>
  );
}

/** Shaped like `CompactLinkRow`: a square tile, two lines, a thin bar, two small buttons. */
function LinkSkeletonRows({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} data-testid="link-skeleton-row" className={PANEL_ROW}>
          <Skeleton width={32} height={32} className="shrink-0 rounded-[9px]" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton width={`${45 + ((i * 13) % 25)}%`} height={11} className="rounded-md" />
            <Skeleton width={`${55 + ((i * 9) % 20)}%`} height={9} className="rounded-md" />
            <Skeleton width="100%" height={2} className="rounded-full" />
          </div>
          <span className={LINK_ACTION_SLOT}>
            <Skeleton width={28} height={28} className="rounded-md" />
            <Skeleton width={28} height={28} className="rounded-md" />
          </span>
        </div>
      ))}
    </>
  );
}

/** The panel while its listing is on the wire: rows shaped like the real ones. */
export function PanelSkeleton({ withLinks }: { withLinks: boolean }) {
  return (
    <div role="status" aria-busy="true" aria-label="Loading access">
      <span className="sr-only">Loading who has access…</span>
      <GroupHeader id="access-people-loading" title="People" />
      <SkeletonRows count={4} />
      {withLinks ? (
        <>
          <GroupHeader id="access-links-loading" title="Links" />
          <LinkSkeletonRows count={2} />
        </>
      ) : null}
    </div>
  );
}
