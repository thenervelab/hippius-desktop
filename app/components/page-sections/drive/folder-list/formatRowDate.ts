/**
 * How a drive row writes a date: "Sep 18, 2026 at 2:55 pm".
 *
 * Shared by the drive list and the "Shared with me" list so the two cannot
 * format the same fact two ways on one screen.
 *
 * Takes MILLISECONDS. Server timestamps are seconds — convert at the call
 * site rather than accepting both, since a seconds value read as
 * milliseconds silently renders 1970 instead of failing.
 */
export function formatRowDate(timestampMs: number): string {
  const d = new Date(timestampMs);
  const month = d.toLocaleString("en-US", { month: "short" });
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "pm" : "am";
  hours = hours % 12 || 12;
  return `${month} ${d.getDate()}, ${d.getFullYear()} at ${hours}:${minutes} ${ampm}`;
}
