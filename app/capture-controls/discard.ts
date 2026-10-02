/**
 * From how long a recording is thrown away only after asking. Below it the
 * trash button discards at once: a false start is worth no question, and
 * Loom draws the line in the same place.
 */
export const DISCARD_CONFIRM_SECS = 5;

export function discardNeedsConfirm(elapsedSecs: number): boolean {
  return elapsedSecs >= DISCARD_CONFIRM_SECS;
}
