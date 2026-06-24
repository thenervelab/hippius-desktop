/**
 * Decide whether a home chart should replay its grow-in entrance animation for
 * a data change, and which signature to remember for next time.
 *
 * Both home charts (Storage Usage bars, Available Credits) render a synthetic
 * baseline (7 zero bars) when the query result is momentarily empty — a
 * transient `[]` from a background refetch (TanStack `retry:false` surfaces a
 * failed refetch as `undefined` → empty), a queryKey change, or first mount.
 * Re-firing the entrance animation on that empty→real round-trip remounts every
 * bar and replays the spring grow — the periodic "flash" (F-8). Skipping the
 * empty transition keeps the bars mounted; the animation re-fires only when
 * REAL data actually changes (a genuine range switch, detected by a changed
 * signature such as the series length or a content hash).
 *
 * Pure so the decision is unit-testable without rendering react-spring in jsdom.
 *
 * @param prev    the last remembered signature of real (non-empty) data
 * @param next    the incoming data's signature (length, or content)
 * @param isEmpty whether the incoming data is the empty/fallback case
 * @returns the signature to remember and whether to re-fire the animation
 */
export function nextChartAnimState(
  prev: string,
  next: string,
  isEmpty: boolean,
): { signature: string; reanimate: boolean } {
  if (isEmpty) return { signature: prev, reanimate: false };
  if (next !== prev) return { signature: next, reanimate: true };
  return { signature: prev, reanimate: false };
}
