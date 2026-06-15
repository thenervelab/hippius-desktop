// Build the tooltip lines for the SharedLinkBadge.
//
// Single-share rows get a two-line tooltip: relative time on top,
// absolute on detail. Multi-share rows collapse to one line — count
// plus the soonest-expiring relative time. Stacking N timestamps would
// balloon the tooltip; the count + soonest is enough signal that the
// user should go to /shares for the full picture.

import type { ShareSummary } from "@/app/lib/tauri/shares";
import { formatRelative } from "@/app/lib/utils/timeRelative";

export function buildSharedBadgeTooltip(rows: ShareSummary[]): string[] | null {
  if (rows.length === 0) return null;

  if (rows.length === 1) {
    const [r] = rows;
    const absolute = new Date(r.expiresAt).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    return [
      `Shared via public link · expires ${formatRelative(r.expiresAt)}`,
      `Expires ${absolute}`,
    ];
  }

  const soonest = rows.reduce((acc, r) =>
    Date.parse(r.expiresAt) < Date.parse(acc.expiresAt) ? r : acc,
  );
  return [
    `Shared via ${rows.length} public links · soonest expires ${formatRelative(soonest.expiresAt)}`,
  ];
}
