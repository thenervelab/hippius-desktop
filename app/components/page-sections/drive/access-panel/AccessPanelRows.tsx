"use client";

// The Manage access panel's own rows: folder holders, links, and the small
// pieces around the groups. Member, owner and pending-invite rows are the
// Share dialog's (`share-dialog/PeopleWithAccessSection`), reused as they are.

import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Clock, Folder, FolderPen, Link2, Lock, Plus, Users } from "lucide-react";
import { toast } from "sonner";

import { Button, Icons, Skeleton } from "@/components/ui";
import ConfirmationDialog from "@/components/ConfirmationDialog";
import TableActionMenu from "@/components/ui/alt-table/TableActionMenu";
import { cn } from "@/lib/utils";
import AccountLabel from "../AccountLabel";
import { BusyLabel, PersonAvatar, type Busy } from "../share-dialog/PeopleWithAccessSection";
import ChangeFoldersDialog, { type FolderRole } from "./ChangeFoldersDialog";
import type { AccessPanelHolder, AccessPanelLink } from "@/app/lib/tauri/sharedDrives";
import { accountDisplayName } from "@/app/lib/shared-drives/accountLabel";
import { driveRoleLabel, parseDriveRole } from "@/app/lib/shared-drives/roles";
import { truncateInviteUrl } from "@/app/lib/shared-drives/inviteLink";
import {
  ACCESS_PANEL_COPY,
  endedLinksLine,
  holderFolderTag,
  linkCreator,
  linkEndedLabel,
  linkMeta,
  linkTitle,
  linkUsage,
} from "./accessPanelView";

export const PANEL_ROW = "flex min-h-[48px] min-w-0 items-center gap-3 py-2";
const MUTED = "text-xs text-grey-50 dark:text-grey-dark-600";
const ROLE_TEXT = "shrink-0 text-xs text-grey-50 dark:text-grey-dark-600";
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
}: {
  id: string;
  title: string;
  count?: React.ReactNode;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex items-center justify-between gap-2 pb-1 pt-4">
      <h3 id={id} className="text-xs font-semibold uppercase tracking-[0.04em] text-grey-50 dark:text-grey-dark-600">
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

/** The small dashed tag naming the folder a row is about. */
export function FolderTag({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex min-w-0 max-w-[70%] shrink-0 items-center gap-1 rounded-md border border-dashed border-grey-80 px-1.5 text-[11px] leading-[18px] text-grey-50 dark:border-white/15 dark:text-grey-dark-600"
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
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <AccountLabel
            ss58={holder.memberSs58}
            name={holder.memberName}
            email={holder.memberEmail}
            className="text-sm text-grey-10 dark:text-white"
          />
          {holder.isYou ? <span className="shrink-0 text-xs text-grey-50 dark:text-grey-dark-600">(you)</span> : null}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
          <FolderTag title={folders.join(", ")}>{holderFolderTag(holder)}</FolderTag>
          {holder.memberEmail ? <span className={cn(MUTED, "min-w-0 truncate")}>{holder.memberEmail}</span> : null}
        </div>
      </div>
      {busy ? <BusyLabel busy={busy} /> : <span className={ROLE_TEXT}>{driveRoleLabel(parseDriveRole(holder.role))}</span>}
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
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  if (url) {
    const copy = async () => {
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

/** One working link: who it makes people, who made it, how used, the link. */
export function LinkRow({
  link,
  busy,
  locked,
  unlocking,
  onUnlock,
  onRevoke,
}: {
  link: AccessPanelLink;
  busy?: Busy;
  locked: boolean;
  unlocking: boolean;
  onUnlock: () => void;
  onRevoke: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const creator = linkCreator(link);
  const title = linkTitle(link);

  return (
    <div className={cn("flex min-w-0 items-start gap-3 py-2", busy && "opacity-60")} aria-busy={busy ? true : undefined}>
      <span aria-hidden className={ICON_TILE}>
        <Link2 className="size-4" />
      </span>
      <div className="grid min-w-0 flex-1 gap-1.5">
        <div className="min-w-0">
          <p className="truncate text-sm text-grey-10 dark:text-white">
            {title}
            {creator ? <span className="text-xs text-grey-50 dark:text-grey-dark-600"> · by {creator}</span> : null}
          </p>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
            {link.pathPrefix ? <FolderTag>{link.pathPrefix}</FolderTag> : null}
            <span className={cn(MUTED, "min-w-0 break-words")}>{linkMeta(link)}</span>
          </div>
        </div>
        {link.singleUse ? null : (
          <div
            role="progressbar"
            aria-label={`${linkUsage(link)}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={link.usagePercent}
            className="h-1 overflow-hidden rounded bg-grey-90 dark:bg-white/10"
          >
            <span
              className="block h-full rounded bg-primary-50 dark:bg-primary-brand-dark"
              style={{ width: `${link.usagePercent}%` }}
            />
          </div>
        )}
        {link.linkAvailable ? (
          <LinkField url={link.inviteUrl} locked={locked} onUnlock={onUnlock} unlocking={unlocking} />
        ) : null}
      </div>
      {busy ? (
        <BusyLabel busy={busy} />
      ) : (
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
      )}
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
    </div>
  );
}

/** A link that no longer works: what it was, and why it stopped. */
function EndedLinkRow({ link }: { link: AccessPanelLink }) {
  return (
    <div className="flex min-w-0 items-center gap-3 py-2 opacity-80">
      <span aria-hidden className={ICON_TILE}>
        <Link2 className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-grey-30 dark:text-grey-dark-700">{linkTitle(link)}</p>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
          {link.pathPrefix ? <FolderTag>{link.pathPrefix}</FolderTag> : null}
          <span className={cn(MUTED, "min-w-0 truncate")}>
            {linkEndedLabel(link.status)} · {linkUsage(link)}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Links that no longer work, folded into one line until opened. */
export function EndedLinks({ links }: { links: AccessPanelLink[] }) {
  const [open, setOpen] = useState(false);
  if (links.length === 0) return null;
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
        <ul>
          {links.map((l) => (
            <li key={l.inviteId}>
              <EndedLinkRow link={l} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
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
          <SkeletonRows count={2} />
        </>
      ) : null}
    </div>
  );
}
