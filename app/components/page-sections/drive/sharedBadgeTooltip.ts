// Build the tooltip lines for the SharedLinkBadge.
//
// Single-share rows get a two-line tooltip: relative time on top,
// absolute on detail. Multi-share rows collapse to one line — count
// plus the soonest-expiring relative time. Stacking N timestamps would
// balloon the tooltip; the count + soonest is enough signal that the
// user should go to /shares for the full picture.
//
// A share can now be set to never expire (`expiresAt === null`), which the
// sorting below has to treat as "later than every real timestamp" rather than
// letting `Date.parse(null)` produce NaN and poison the comparison.

import { formatRelative } from "@/app/lib/utils/timeRelative";

/**
 * The slice of a share row the tooltip needs. Both `ShareSummary` (file
 * shares) and `FolderShareSummary` (live folder shares) satisfy it, so the
 * badge builds the same copy for either kind.
 */
export interface SharedBadgeRow {
  expiresAt: string | null;
  isPrivate: boolean;
}

/** Sort key for expiry: a never-expiring link sorts after every dated one. */
function expiryRank(row: SharedBadgeRow): number {
  return row.expiresAt === null
    ? Number.POSITIVE_INFINITY
    : Date.parse(row.expiresAt);
}

/** "public" or "password-protected", for the tooltip's first line. */
function accessLabel(row: SharedBadgeRow): string {
  return row.isPrivate ? "password-protected link" : "public link";
}

export function buildSharedBadgeTooltip(rows: SharedBadgeRow[]): string[] | null {
  if (rows.length === 0) return null;

  if (rows.length === 1) {
    const [r] = rows;
    if (r.expiresAt === null) {
      return [`Shared via ${accessLabel(r)} · no expiry`, "Active until revoked"];
    }
    const absolute = new Date(r.expiresAt).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    return [
      `Shared via ${accessLabel(r)} · expires ${formatRelative(r.expiresAt)}`,
      `Expires ${absolute}`,
    ];
  }

  const soonest = rows.reduce((acc, r) =>
    expiryRank(r) < expiryRank(acc) ? r : acc,
  );
  // Every link never expires, so there is no "soonest" to report.
  if (soonest.expiresAt === null) {
    return [`Shared via ${rows.length} links · no expiry`];
  }
  return [
    `Shared via ${rows.length} links · soonest expires ${formatRelative(soonest.expiresAt)}`,
  ];
}
