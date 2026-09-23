/**
 * Whether the browsed level's pager is worth drawing.
 *
 * Rows per page. Not a preset in the size control's list, deliberately:
 * `buildPageSizeOptions` merges the size a table opens on into the options,
 * so 20 is offered alongside 10/25/50/100 rather than silently rounding to
 * one of them.
 */
export const DEFAULT_BROWSE_PAGE_SIZE = 20;

export interface BrowsePagerVisibility {
  /** Paging applies to this view at all (not a search result, not Recent). */
  pagingActive: boolean;
  totalPages: number;
  pageSize: number;
  defaultPageSize?: number;
}

/**
 * Show the pager when there is more than one page, OR when the reader has
 * chosen a page size of their own.
 *
 * The second half is the part that is easy to miss. The size control lives
 * INSIDE the pager, so hiding the pager hides the only way to change the
 * size — and a reader who picks 50 and then opens a folder of 40 files is
 * left on 50 with no way back to 20, on that folder and every smaller one
 * after it. The control has to outlive the page count that summoned it.
 *
 * At the default size it stays hidden while everything fits, because then it
 * is a control with nothing to do: no second page to reach, and no choice to
 * undo. Setting the size back to the default hides it again, so the surface
 * returns to quiet on its own rather than staying cluttered for the session.
 */
export function shouldShowBrowsePager({
  pagingActive,
  totalPages,
  pageSize,
  defaultPageSize = DEFAULT_BROWSE_PAGE_SIZE,
}: BrowsePagerVisibility): boolean {
  if (!pagingActive) return false;
  return totalPages > 1 || pageSize !== defaultPageSize;
}

/**
 * Where the chosen rows-per-page is remembered.
 *
 * Presentation state, kept in localStorage beside the theme preference
 * rather than in the Rust `user_preferences` table: it says nothing about
 * the account or its data, only about how this device likes to read a list.
 */
export const BROWSE_PAGE_SIZE_STORAGE_KEY = "hippius:drive-page-size";

/**
 * The largest size that may be restored from storage. Bigger than any preset
 * the control offers, so a future one still survives a round trip, but
 * bounded: a hand-edited or corrupted entry must not open the drive with a
 * hundred thousand rows in it.
 */
export const MAX_BROWSE_PAGE_SIZE = 500;

/**
 * Read a stored page size back, falling back to the default for anything that
 * is not a whole, positive, in-range number.
 *
 * Storage is a string typed by nobody: a missing key, a half-written value,
 * `"0"`, `"-5"`, `"20.5"` all have to land somewhere sensible — and a zero or
 * a NaN divides the level into an infinite page count.
 */
export function normalizeBrowsePageSize(
  stored: unknown,
  fallback: number = DEFAULT_BROWSE_PAGE_SIZE,
): number {
  const value = typeof stored === "string" ? Number(stored) : stored;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (!Number.isInteger(value)) return fallback;
  if (value < 1 || value > MAX_BROWSE_PAGE_SIZE) return fallback;
  return value;
}

