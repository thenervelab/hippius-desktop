// "Does this file or folder already have a live link, and what can be copied
// from here?", decided without React so every surface asks it the same way:
// the Drive, Captures and Recent Files menus (table, cards, right-click), the
// file viewer and the Share via link dialog.
//
// Which links belong to which file is not decided here: that is
// `captureSharesFrom` (files) and the folder-share listing's
// `(folderHash, pathPrefix)` lookup (folders), the same rules the row's link
// icon and its Insights use. This only takes the newest of those links
// (`newestShare`, as Insights does) and says what this computer can do with
// it, through the Insights panel's own `panelLink`, so the menu, the dialog
// and the panel can never disagree about whether a link is copyable.

import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { FolderShareSummary, ShareSummary } from "@/app/lib/tauri/shares";
import { newestShare } from "@/app/lib/utils/fileLinks";
import { folderShareRelativePath } from "@/app/lib/utils/folderShareGating";
import { resolveRowRelativePath } from "@/app/lib/utils/rowRelativePath";
import { fileShareRowId, folderShareRowId } from "@/app/lib/utils/sharesPageLink";
import { panelLink } from "@/components/page-sections/shares/insights/panelLinkMedia";

/**
 * What can be done with the link from this computer:
 *
 * - `ready`: the full link, key included, is here and can be copied.
 * - `locked`: Hippius is locked on this computer, and the key of a link made
 *   elsewhere comes back once it is unlocked (Rust opens the owner wrap).
 * - `elsewhere`: the key is not on this computer at all (an older link made
 *   on another device, or a password link made elsewhere).
 */
export type ExistingLinkState = "ready" | "locked" | "elsewhere";

export interface ExistingLink {
  state: ExistingLinkState;
  /** The full link with its key, only when `ready`. */
  url: string | null;
  /** A password link: the copied link still needs its password to open. */
  needsPassword: boolean;
  /**
   * Whether the link has a password: `null` when this computer cannot tell
   * (no key here), which must not read as "no password".
   */
  isPrivate: boolean | null;
  /** RFC 3339. */
  createdAt: string;
  /** RFC 3339, `null` when the link never expires. */
  expiresAt: string | null;
  /** Views, only when the server's listing carries them. */
  views?: number;
  /** How many live links the item has; the newest is the one described. */
  count: number;
  kind: "file" | "folder";
  /** The file link's token (for its Insights); `null` for a folder link. */
  shareToken: string | null;
  /** The Shared Links rows to highlight for "Manage in Shared Links". */
  manageRowIds: string[];
}

/** The menu item's words. */
export const COPY_LINK_LABEL = "Copy link";
export const UNLOCK_TO_COPY_LINK_LABEL = "Unlock to copy link";

/** Said when the link's key is not on this computer, on every surface. */
export const LINK_ELSEWHERE_MESSAGE =
  "This link was made on another device or in the browser, so its key isn't on this computer. Copy it there, or use Share via link to make a new one.";

export function copyLinkLabel(link: Pick<ExistingLink, "state">): string {
  return link.state === "locked" ? UNLOCK_TO_COPY_LINK_LABEL : COPY_LINK_LABEL;
}

function stateOf(url: string | null, locked: boolean): ExistingLinkState {
  const panel = panelLink({ shareUrl: url, isPrivate: false }, locked);
  if (panel.kind === "ready") return "ready";
  return panel.kind === "locked" ? "locked" : "elsewhere";
}

/** A file's live links (`captureSharesFrom`) → what can be copied, or `null`. */
export function existingFileLink(rows: readonly ShareSummary[], locked: boolean): ExistingLink | null {
  const newest = newestShare(rows);
  if (!newest) return null;
  const state = stateOf(newest.shareUrl, locked);
  return {
    state,
    url: state === "ready" ? newest.shareUrl : null,
    needsPassword: state === "ready" && newest.isPrivate === true,
    // `isPrivate` is `false` whenever the key is missing, so it is only
    // known when the link is here.
    isPrivate: newest.shareUrl ? newest.isPrivate === true : null,
    createdAt: newest.createdAt,
    expiresAt: newest.expiresAt,
    ...(typeof newest.views === "number" ? { views: newest.views } : {}),
    count: rows.length,
    kind: "file",
    shareToken: newest.shareToken,
    manageRowIds: rows.map((r) => fileShareRowId(r.shareToken)),
  };
}

/**
 * A folder's live links (already filtered to live rows by
 * `selectFolderSharesFor`) → what can be copied, or `null`.
 */
export function existingFolderLink(rows: readonly FolderShareSummary[], locked: boolean): ExistingLink | null {
  const newest = newestShare(rows);
  if (!newest) return null;
  const state = stateOf(newest.shareUrl, locked);
  return {
    state,
    url: state === "ready" ? newest.shareUrl : null,
    needsPassword: state === "ready" && newest.isPrivate === true,
    isPrivate: newest.isPrivate,
    createdAt: newest.createdAt,
    expiresAt: newest.expiresAt,
    count: rows.length,
    kind: "folder",
    shareToken: null,
    manageRowIds: rows.map((r) => folderShareRowId(r.tokenHash)),
  };
}

/**
 * The drive-relative path a row's links are found under: the path a folder's
 * link is minted for (`folderShareRelativePath`), or a file's path resolved
 * the way its link icon resolves it (`resolveRowRelativePath`). `basePath` is
 * the folder the row is listed in.
 */
export function linkPathFor(file: FormattedUserFile, basePath: string | null | undefined): string {
  if (file.isFolder) return folderShareRelativePath(file, basePath);
  return resolveRowRelativePath(basePath ?? "", file.actualFileName || file.name);
}

/**
 * The facts line under an existing link: when it was made, when it ends,
 * whether it has a password and how many views, as far as they are known.
 */
export function linkFacts(link: ExistingLink, now: Date = new Date()): string[] {
  const facts: string[] = [];
  const made = formatDay(link.createdAt, now);
  if (made) facts.push(`Created ${made}`);
  if (link.expiresAt === null) {
    facts.push("Never expires");
  } else {
    const ends = formatDay(link.expiresAt, now);
    if (ends) facts.push(`Expires ${ends}`);
  }
  if (link.isPrivate === true) facts.push("Password protected");
  else if (link.isPrivate === false) facts.push("No password");
  if (typeof link.views === "number") facts.push(link.views === 1 ? "1 view" : `${link.views} views`);
  return facts;
}

/** "today", "yesterday", or a short date ("3 Oct", with the year when not this one). */
function formatDay(rfc3339: string, now: Date): string | null {
  const ms = Date.parse(rfc3339);
  if (Number.isNaN(ms)) return null;
  const date = new Date(ms);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(date) - startOf(now)) / 86_400_000);
  if (days === 0) return "today";
  if (days === -1) return "yesterday";
  if (days === 1) return "tomorrow";
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}
