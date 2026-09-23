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
