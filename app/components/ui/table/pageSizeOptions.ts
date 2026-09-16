/**
 * The page sizes a table's size control should offer.
 *
 * Two sizes are merged into the standard list on top of the presets:
 *
 * - `current` — a `<select>` whose `value` matches no `<option>` silently
 *   displays the FIRST one instead, so a table paging by 20 under options of
 *   10/25/50/100 reports "10/PAGE" while showing twenty rows.
 * - `initial` — the size the table started on. Merging only `current` makes a
 *   non-preset default a ONE-WAY door: Drive opens at 20, and the moment the
 *   user picks 25 the 20 option is recomputed away, with no way back to the
 *   size they started on short of reopening the app.
 *
 * Returned ascending so an added size reads in its natural place rather than
 * tacked on the end.
 */
export function buildPageSizeOptions({
  options,
  current,
  initial,
}: {
  options: number[];
  current?: number;
  initial?: number;
}): number[] {
  const merged = new Set(options);
  // Guard against 0/NaN: neither is a usable page size, and both would render
  // a nonsense "0/PAGE" entry.
  if (current && Number.isFinite(current)) merged.add(current);
  if (initial && Number.isFinite(initial)) merged.add(initial);
  return Array.from(merged).sort((a, b) => a - b);
}
