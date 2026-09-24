"use client";

// The Manage access panel's two shapes, and the pieces they share.
//
//   Main view   every group's first rows (`PANEL_GROUP_PREVIEW`), a jump bar
//               above the list, and "Show all N …" under a group with more.
//   Full view   one group, all of it: a search field, filter chips and a
//               windowed list, behind a "‹ Back" sub-header.
//
// Which rows exist, their order and every change still come from Rust; this
// file only arranges them. Row changes stay pessimistic in both views: the
// busy and refusal state lives above the view (`useRowChanges`), so a row
// scrolled out of the window and back in still says "Saving…".

import React, { useMemo, useRef } from "react";
import { ChevronLeft, Search, X } from "lucide-react";

import { cn } from "@/lib/utils";
import type {
  AccessPanel,
  AccessPanelInvite,
  AccessPanelLink,
} from "@/app/lib/tauri/sharedDrives";
import { accountDisplayName } from "@/app/lib/shared-drives/accountLabel";
import { driveRoleLabel, parseDriveRole, type DriveRole } from "@/app/lib/shared-drives/roles";
import { InlineNotice } from "../share-dialog/InlineNotice";
import { MemberRow, OwnerRow, PendingRow, type Busy } from "../share-dialog/PeopleWithAccessSection";
import type { FolderRole } from "./ChangeFoldersDialog";
import { EndedLinkRow, EndedLinks, FolderTag, HolderRow, LinkRow } from "./AccessPanelRows";
import {
  ACCESS_PANEL_COPY,
  GROUP_SHORT,
  GROUP_TITLE,
  LINKS_FILTERS,
  PEOPLE_FILTERS,
  SEARCH_PLACEHOLDER,
  linkMatches,
  memberMeta,
  noMatchLine,
  pendingLeft,
  pendingMatches,
  pendingStage,
  personInFilter,
  personKey,
  personMatches,
  type LinksFilter,
  type PanelGroup,
  type PanelPerson,
  type PeopleFilter,
} from "./accessPanelView";
import { useWindowedRows } from "./useWindowedRows";

export type RowActions = {
  changeRole: (ss58: string, who: string, role: DriveRole) => void;
  remove: (ss58: string, who: string) => void;
  revoke: (inviteId: string, who: string) => void;
  cancel: (inviteId: string, who: string) => void;
  approve: (inviteId: string, who: string) => void;
  changeFolders: (ss58: string, folders: string[], role?: FolderRole) => Promise<void>;
};

/** Everything a row needs besides its own data. */
export type RowContext = {
  panel: AccessPanel;
  folder: boolean;
  busy: Record<string, Busy>;
  rowError: { key: string; message: string } | null;
  actions: RowActions;
  locked: boolean;
  unlocking: boolean;
  onUnlock: () => void;
};

/** The key a row's busy and refusal state are filed under. */
function busyKeyOf(person: PanelPerson): string | null {
  if (person.kind === "owner") return null;
  return person.kind === "member" ? person.member.memberSs58 : person.holder.memberSs58;
}

/** A row's refusal, if its last change was refused, under it. */
function RowRefusal({ id, rowError }: { id: string | null; rowError: RowContext["rowError"] }) {
  if (!id || rowError?.key !== id) return null;
  return (
    <InlineNotice tone="error" className="mb-2">
      {rowError.message}
    </InlineNotice>
  );
}

export function PersonItem({ person, ctx }: { person: PanelPerson; ctx: RowContext }) {
  const { panel, busy, rowError, actions, folder } = ctx;
  if (person.kind === "owner") return <OwnerRow ss58={person.ss58} isYou={person.isYou} name={person.name} />;
  if (person.kind === "member") {
    const m = person.member;
    const who = accountDisplayName(m.memberSs58, m.memberName);
    return (
      <>
        <MemberRow
          member={m}
          busy={busy[m.memberSs58]}
          readOnly={!panel.canManage}
          meta={memberMeta(m, folder)}
          onChangeRole={(role) => actions.changeRole(m.memberSs58, who, role)}
          onRemove={() => actions.remove(m.memberSs58, who)}
        />
        <RowRefusal id={busyKeyOf(person)} rowError={rowError} />
      </>
    );
  }
  const h = person.holder;
  const who = accountDisplayName(h.memberSs58, h.memberName);
  return (
    <>
      <HolderRow
        holder={h}
        busy={busy[h.memberSs58]}
        canManage={panel.canManage}
        onRemove={() => actions.remove(h.memberSs58, who)}
        onChangeFolders={(next, role) => actions.changeFolders(h.memberSs58, next, role)}
      />
      <RowRefusal id={busyKeyOf(person)} rowError={rowError} />
    </>
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

export function PendingItem({ invite, ctx }: { invite: AccessPanelInvite; ctx: RowContext }) {
  const who = invite.recipientEmail ?? "this invitation";
  const left = pendingLeft(invite.expiresInSecs);
  const roleLine = [driveRoleLabel(parseDriveRole(invite.role)), left].filter(Boolean).join(" · ");
  return (
    <>
      <PendingRow
        invite={invite}
        busy={ctx.busy[invite.inviteId]}
        onCancel={() => ctx.actions.cancel(invite.inviteId, who)}
        onApprove={() => ctx.actions.approve(invite.inviteId, who)}
        meta={
          <>
            <StagePill status={invite.emailStatus} />
            {invite.pathPrefix ? <FolderTag>{invite.pathPrefix}</FolderTag> : null}
            <span className="min-w-0 truncate" title={roleLine}>
              {roleLine}
            </span>
          </>
        }
      />
      <RowRefusal id={invite.inviteId} rowError={ctx.rowError} />
    </>
  );
}

export function LinkItem({ link, ctx }: { link: AccessPanelLink; ctx: RowContext }) {
  return (
    <>
      <LinkRow
        link={link}
        busy={ctx.busy[link.inviteId]}
        locked={ctx.locked}
        unlocking={ctx.unlocking}
        onUnlock={ctx.onUnlock}
        onRevoke={() => ctx.actions.revoke(link.inviteId, "this link")}
      />
      <RowRefusal id={link.inviteId} rowError={ctx.rowError} />
    </>
  );
}

/** A compact search field; the label is for screen readers, the placeholder for the eye. */
export function PanelSearch({
  value,
  onChange,
  label,
  placeholder,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
  placeholder: string;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className={cn(
        "flex h-8 min-w-0 items-center gap-1.5 rounded-[8px] border border-grey-80 bg-white px-2.5 focus-within:border-primary-50 dark:border-white/10 dark:bg-[#1f1f1f] dark:focus-within:border-primary-brand-dark",
        className,
      )}
    >
      <Search className="size-3.5 shrink-0 text-grey-50 dark:text-grey-dark-600" aria-hidden />
      <input
        ref={input}
        type="search"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-grey-10 outline-none placeholder:text-grey-60 dark:text-white dark:placeholder:text-grey-dark-600 [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onChange("");
            input.current?.focus();
          }}
          className="flex size-5 shrink-0 items-center justify-center rounded-full text-grey-50 hover:text-grey-10 dark:text-grey-dark-600 dark:hover:text-white"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

/** A group's count in the jump bar. */
export type SummaryItem = { group: PanelGroup; count: number };

/**
 * The jump bar under the panel's header: one button per group with rows,
 * each scrolling the list to its group. It sits outside the scrolling list,
 * so it stays in view however far the list is scrolled.
 */
export function SummaryBar({ items, onJump }: { items: SummaryItem[]; onJump: (group: PanelGroup) => void }) {
  return (
    <nav
      aria-label="Jump to a group"
      className="flex shrink-0 flex-wrap items-center gap-x-1 gap-y-0.5 border-b border-grey-80 px-3 py-1.5 dark:border-white/10"
    >
      {items.map((item, i) => (
        <React.Fragment key={item.group}>
          {i > 0 ? (
            <span aria-hidden className="text-xs text-grey-60 dark:text-grey-dark-700">
              ·
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => onJump(item.group)}
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-1 text-xs text-grey-40 transition-colors hover:bg-grey-90 hover:text-grey-10 dark:text-grey-dark-500 dark:hover:bg-white/10 dark:hover:text-white"
          >
            {GROUP_SHORT[item.group]}
            <span className="font-semibold text-grey-10 dark:text-white">{item.count}</span>
          </button>
        </React.Fragment>
      ))}
    </nav>
  );
}

/** One chip set: a single choice, like a segmented control. */
function FilterChips<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex min-w-0 flex-wrap gap-1.5">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.id)}
            className={cn(
              "h-7 whitespace-nowrap rounded-full border px-2.5 text-xs font-medium transition-colors",
              on
                ? "border-primary-50 bg-primary-50/10 text-primary-50 dark:border-primary-brand-dark dark:bg-primary-brand-dark/15 dark:text-primary-brand-dark"
                : "border-grey-80 text-grey-40 hover:bg-grey-90 dark:border-white/10 dark:text-grey-dark-500 dark:hover:bg-white/10",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** What a full view is showing: the group, the search and the chip. */
export type FullViewState = {
  group: PanelGroup;
  query: string;
  peopleFilter: PeopleFilter;
  linksFilter: LinksFilter;
};

/**
 * The strip above a full view's list: "‹ Back", the group's name and count,
 * the search field and the chips. It does not scroll with the list.
 */
export function FullViewHeader({
  view,
  total,
  onBack,
  onChange,
}: {
  view: FullViewState;
  total: number;
  onBack: () => void;
  onChange: (next: FullViewState) => void;
}) {
  const title = GROUP_TITLE[view.group];
  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-grey-80 px-4 pb-3 pt-2 dark:border-white/10">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex shrink-0 items-center gap-0.5 rounded-md py-1 pl-0.5 pr-1.5 text-xs font-medium text-primary-50 hover:bg-grey-90/60 dark:text-primary-brand-dark dark:hover:bg-white/5"
        >
          <ChevronLeft className="size-4" aria-hidden />
          Back
        </button>
        <h3 className="min-w-0 truncate text-sm font-semibold text-grey-10 dark:text-white">
          {title} <span className="font-medium text-grey-50 dark:text-grey-dark-600">{total}</span>
        </h3>
      </div>
      <PanelSearch
        value={view.query}
        onChange={(query) => onChange({ ...view, query })}
        label={`Search ${title.toLowerCase()}`}
        placeholder={SEARCH_PLACEHOLDER[view.group]}
      />
      {view.group === "people" ? (
        <FilterChips
          label="Show"
          options={PEOPLE_FILTERS}
          value={view.peopleFilter}
          onChange={(peopleFilter) => onChange({ ...view, peopleFilter })}
        />
      ) : null}
      {view.group === "links" ? (
        <FilterChips
          label="Show"
          options={LINKS_FILTERS}
          value={view.linksFilter}
          onChange={(linksFilter) => onChange({ ...view, linksFilter })}
        />
      ) : null}
    </div>
  );
}

/** Row heights before measuring, per kind: close enough that the scrollbar barely moves. */
const ESTIMATE = { people: 56, pending: 60, links: 128, ended: 52 } as const;

type FullRow =
  | { key: string; kind: "person"; person: PanelPerson }
  | { key: string; kind: "pending"; invite: AccessPanelInvite }
  | { key: string; kind: "link"; link: AccessPanelLink }
  | { key: string; kind: "ended"; link: AccessPanelLink };

/** The rows a full view lists, after its search and chip. */
export function fullViewRows(view: FullViewState, people: PanelPerson[], panel: AccessPanel): FullRow[] {
  if (view.group === "people") {
    return people
      .filter((p) => personInFilter(p, view.peopleFilter) && personMatches(p, view.query))
      .map((person) => ({ key: personKey(person), kind: "person", person }));
  }
  if (view.group === "pending") {
    return panel.pendingInvites
      .filter((i) => pendingMatches(i, view.query))
      .map((invite) => ({ key: invite.inviteId, kind: "pending", invite }));
  }
  if (view.linksFilter === "ended") {
    return panel.inactiveLinks
      .filter((l) => linkMatches(l, view.query))
      .map((link) => ({ key: link.inviteId, kind: "ended", link }));
  }
  return panel.links
    .filter((l) => linkMatches(l, view.query))
    .map((link) => ({ key: link.inviteId, kind: "link", link }));
}

/**
 * A full view's list: every row the search and chip leave, drawn in a window
 * around what is on screen. `scrollRef` is the panel body that scrolls.
 */
export function FullViewList({
  view,
  people,
  ctx,
  scrollRef,
  onChange,
}: {
  view: FullViewState;
  people: PanelPerson[];
  ctx: RowContext;
  scrollRef: React.RefObject<HTMLElement | null>;
  onChange: (next: FullViewState) => void;
}) {
  const { panel } = ctx;
  const rows = useMemo(() => fullViewRows(view, people, panel), [view, people, panel]);
  const keys = useMemo(() => rows.map((r) => r.key), [rows]);
  const listRef = useRef<HTMLUListElement>(null);
  const estimate =
    view.group === "links" ? (view.linksFilter === "ended" ? ESTIMATE.ended : ESTIMATE.links) : ESTIMATE[view.group];
  const windowed = useWindowedRows({ keys, estimate, scrollRef, listRef });
  const activeLinks = view.group === "links" && view.linksFilter === "active";

  let empty: string | null = null;
  if (rows.length === 0) {
    if (view.query.trim()) empty = noMatchLine(view.query);
    else if (view.group === "links") empty = view.linksFilter === "ended" ? "No expired or revoked links" : "No active links";
    else empty = "No one here";
  }

  return (
    <div className="pt-2">
      {activeLinks && ctx.locked ? (
        <InlineNotice tone="info" className="mb-1">
          {ACCESS_PANEL_COPY.linksLocked}
        </InlineNotice>
      ) : null}
      {empty ? (
        <p role="status" className="px-1 py-8 text-center text-sm text-grey-50 dark:text-grey-dark-600">
          {empty}
        </p>
      ) : null}
      <ul
        ref={listRef}
        aria-label={GROUP_TITLE[view.group]}
        className="relative"
        style={{ height: windowed.totalHeight }}
      >
        {windowed.rows.map(({ index, key, start }) => {
          const row = rows[index];
          return (
            <li
              key={key}
              ref={windowed.measure}
              data-row-key={key}
              aria-setsize={rows.length}
              aria-posinset={index + 1}
              className="absolute inset-x-0 top-0"
              style={{ transform: `translateY(${start}px)` }}
            >
              {row.kind === "person" ? <PersonItem person={row.person} ctx={ctx} /> : null}
              {row.kind === "pending" ? <PendingItem invite={row.invite} ctx={ctx} /> : null}
              {row.kind === "link" ? <LinkItem link={row.link} ctx={ctx} /> : null}
              {row.kind === "ended" ? <EndedLinkRow link={row.link} /> : null}
            </li>
          );
        })}
      </ul>
      {activeLinks && !view.query.trim() ? (
        <EndedLinks links={panel.inactiveLinks} onShowAll={() => onChange({ ...view, linksFilter: "ended" })} />
      ) : null}
    </div>
  );
}
