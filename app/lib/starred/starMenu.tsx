// The Star / Unstar item every file, folder and drive menu carries, and where
// it goes: right after Download, or right after Open when there is no
// Download (a drive, a folder only on the server).

import React from "react";
import { Star } from "lucide-react";
import type { ActionItem } from "@/components/ui/alt-table/TableActionMenu";

export const STAR_LABEL = "Star";
export const UNSTAR_LABEL = "Unstar";

/** The item's label for a row that is (not) starred now. */
export function starMenuLabel(starred: boolean): string {
  return starred ? UNSTAR_LABEL : STAR_LABEL;
}

/** The icon: an outline star to star, a filled one to unstar. */
export function StarMenuIcon({ starred, className = "size-4" }: { starred: boolean; className?: string }) {
  return <Star className={className} fill={starred ? "currentColor" : "none"} aria-hidden="true" />;
}

/** The menu item itself. */
export function starMenuItem(starred: boolean, onToggle: () => void, disabled = false): ActionItem {
  return {
    icon: <StarMenuIcon starred={starred} />,
    itemTitle: starMenuLabel(starred),
    onItemClick: onToggle,
    disabled,
  };
}

/**
 * `items` with `star` placed right after Download, else right after Open,
 * else first. Matched on the visible label, which is what the rule is about.
 */
export function withStarItem(items: ActionItem[], star: ActionItem | null): ActionItem[] {
  if (!star) return items;
  const titleOf = (item: ActionItem) => (typeof item.itemTitle === "string" ? item.itemTitle : "");
  let at = items.findIndex((item) => titleOf(item) === "Download");
  if (at < 0) at = items.findIndex((item) => titleOf(item) === "Open");
  const out = [...items];
  out.splice(at + 1, 0, star);
  return out;
}
