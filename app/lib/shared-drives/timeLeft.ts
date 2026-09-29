/**
 * How long an invitation or a link has left, in words. One helper, so the
 * Share dialog and Manage access never disagree about the same invite.
 *
 * Time left rounds UP to whole units. An invite sent seconds ago with a
 * 7-day lifetime has 6.9999 days left, and people read that as "7 days", not
 * "6 days". "1 day" is shown only once a day or less remains; under that the
 * count is in hours, and under an hour it says so.
 */

const HOUR = 3600;
const DAY = 24 * HOUR;

/**
 * Remaining lifetimes at or past this read as "Never expires". A standing
 * link is minted with the server's 100-year cap, and its remaining time only
 * ever counts down from there, so anything over half the cap is one of those.
 * No real lifetime comes close: mailed invites stop at thirty days.
 */
const NEVER_EXPIRES_FLOOR_SECS = 50 * 365 * DAY;

export type TimeLeft =
  | { kind: "never" }
  | { kind: "expired" }
  /** "7 days", "1 day", "24 hours", "1 hour", "less than an hour". */
  | { kind: "left"; words: string };

/** "7 days", "1 day", "24 hours", "1 hour", "less than an hour", rounding up. */
export function durationWords(secs: number): string {
  if (secs > DAY) {
    return `${Math.ceil(secs / DAY)} days`;
  }
  if (secs === DAY) return "1 day";
  if (secs < HOUR) return "less than an hour";
  const hours = Math.ceil(secs / HOUR);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/** Whether a remaining lifetime is a standing, never-expiring one. */
export function isNeverExpiring(secs: number): boolean {
  return secs >= NEVER_EXPIRES_FLOOR_SECS;
}

/** Sorts a remaining lifetime in seconds into never, expired or words. */
export function timeLeft(secs: number): TimeLeft {
  if (isNeverExpiring(secs)) return { kind: "never" };
  if (secs <= 0) return { kind: "expired" };
  return { kind: "left", words: durationWords(secs) };
}

/** "Expires in 7 days", "Expired", "Never expires". */
export function expiresInWords(secs: number): string {
  const left = timeLeft(secs);
  if (left.kind === "never") return "Never expires";
  if (left.kind === "expired") return "Expired";
  return `Expires in ${left.words}`;
}

/** "7 days left", "Expired", "Never expires". */
export function timeLeftWords(secs: number): string {
  const left = timeLeft(secs);
  if (left.kind === "never") return "Never expires";
  if (left.kind === "expired") return "Expired";
  return `${left.words} left`;
}

/** Seconds from `now` until an RFC 3339 timestamp, or null if unreadable. */
export function secsUntil(rfc3339: string, now: Date = new Date()): number | null {
  const ts = Date.parse(rfc3339);
  if (Number.isNaN(ts)) return null;
  return (ts - now.getTime()) / 1000;
}
