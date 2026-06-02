import type { UploadFeedItem } from "./mergeUploadFeed";

/**
 * Date-bucketed grouping for the tray popover's "Your Uploads" list.
 *
 * Buckets the already-ordered feed (see `mergeUploadFeed`: uploading → failed →
 * completed) by each item's `createdAt`, preserving the feed's order within
 * each bucket. Because live uploading/failed rows carry `createdAt = now`, they
 * naturally fall into "Today" and — being first in the feed — sit at the top of
 * that group, so active work still leads the list.
 *
 * Pure (takes `now` for testability) and returns only non-empty groups in
 * recency order, so the tray can render one heading per group.
 */
export interface UploadFeedGroup {
  label: string;
  items: UploadFeedItem[];
}

const DAY_MS = 86_400_000;

/** Local midnight (ms) for the given date. */
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Group the feed into Today / Yesterday / This Week / Last Week / This Month /
 * Older, newest group first.
 *
 * Bucket bounds are lower-inclusive and checked most-recent-first, so an item
 * is assigned to the first (newest) bucket it qualifies for — this keeps the
 * assignment correct even when bounds aren't strictly monotonic (e.g. early in
 * a month, where "This Month" starts after "Last Week"). Weeks are Monday-based.
 */
export function groupUploadFeed(
  items: UploadFeedItem[],
  now: number = Date.now(),
): UploadFeedGroup[] {
  const nowDate = new Date(now);
  const startToday = startOfDay(nowDate);
  const startYesterday = startToday - DAY_MS;
  // Monday-based week: getDay() is 0=Sun..6=Sat; shift so 0=Mon..6=Sun.
  const mondayOffset = (nowDate.getDay() + 6) % 7;
  const startThisWeek = startToday - mondayOffset * DAY_MS;
  const startLastWeek = startThisWeek - 7 * DAY_MS;
  const startThisMonth = new Date(
    nowDate.getFullYear(),
    nowDate.getMonth(),
    1,
  ).getTime();

  // Order matters: checked top-down, first match wins.
  const buckets: { label: string; min: number }[] = [
    { label: "Today", min: startToday },
    { label: "Yesterday", min: startYesterday },
    { label: "This Week", min: startThisWeek },
    { label: "Last Week", min: startLastWeek },
    { label: "This Month", min: startThisMonth },
  ];

  const groups: UploadFeedGroup[] = buckets.map((b) => ({
    label: b.label,
    items: [],
  }));
  const older: UploadFeedGroup = { label: "Older", items: [] };

  for (const item of items) {
    const ts = item.createdAt;
    const bucketIndex = buckets.findIndex((b) => ts >= b.min);
    if (bucketIndex === -1) {
      older.items.push(item);
    } else {
      groups[bucketIndex].items.push(item);
    }
  }

  return [...groups, older].filter((g) => g.items.length > 0);
}
