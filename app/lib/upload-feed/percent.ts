/**
 * An upload's percent for a progress bar: null when the total is not known
 * yet, and never 100 before the upload reports it finished, so a bar that
 * shows 100 always means done.
 */
export function cappedPercent(sent: number, total: number): number | null {
  if (!(total > 0)) return null;
  return Math.min(99, Math.max(0, Math.round((sent / total) * 100)));
}
