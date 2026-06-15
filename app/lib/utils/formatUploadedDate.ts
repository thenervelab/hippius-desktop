const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** "Just now" window. Past this, the label switches to a counting "Ns ago"
 *  so a row visibly ages instead of sitting on "Just now" for a full minute. */
const JUST_NOW_MS = 20_000;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * User-friendly "uploaded at" label for a millisecond epoch timestamp.
 *
 * Recent uploads read as relative time ("Just now" for the first ~20s, then
 * "45s ago", "5m ago", "3h ago", "2d ago"); anything a week or older falls back to a short absolute date
 * ("5 Jan" within the current year, "5 Jan 2026" otherwise) so the label
 * stays compact and unambiguous. A future timestamp (clock skew) also uses
 * the absolute form rather than a nonsensical negative "ago".
 *
 * Returns "" for a missing or invalid timestamp so the caller can omit the
 * cell entirely instead of rendering a placeholder.
 *
 * `now` is injectable so the relative buckets can be unit-tested without
 * faking the system clock.
 */
export function formatUploadedDate(
  msTimestamp: number,
  now: number = Date.now(),
): string {
  if (!msTimestamp || !Number.isFinite(msTimestamp) || msTimestamp <= 0) {
    return "";
  }
  const date = new Date(msTimestamp);
  if (Number.isNaN(date.getTime())) return "";

  const diff = now - msTimestamp;
  if (diff >= 0 && diff < WEEK_MS) {
    if (diff < JUST_NOW_MS) return "Just now";
    if (diff < MINUTE_MS) return `${Math.floor(diff / SECOND_MS)}s ago`;
    if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m ago`;
    if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h ago`;
    return `${Math.floor(diff / DAY_MS)}d ago`;
  }

  // Older than a week (or a future timestamp): short absolute date. Drop the
  // year when it matches "now" to keep the common case short.
  const day = date.getDate();
  const month = MONTHS[date.getMonth()];
  const year = date.getFullYear();
  return year === new Date(now).getFullYear()
    ? `${day} ${month}`
    : `${day} ${month} ${year}`;
}

export default formatUploadedDate;
