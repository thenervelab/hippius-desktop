/**
 * Paging for the drive list.
 *
 * The list grew without bound, and "Shared with me" sits BELOW it — so an
 * account with twenty drives pushed the drives other people shared with them
 * off the bottom of a surface they never scrolled. Paging the list is what
 * keeps that section reachable, which is the reason it exists rather than a
 * tidiness preference.
 */

/** Drives per page. Enough that a typical account never sees a pager at all. */
export const FOLDER_LIST_PAGE_SIZE = 8;

export interface FolderListPage {
  /** The page actually shown, clamped into range. */
  page: number;
  totalPages: number;
  /** Slice bounds for the rows to render. */
  start: number;
  end: number;
  /** Whether a pager is worth drawing at all. */
  showPager: boolean;
}

/**
 * Resolve which slice of the list to draw.
 *
 * `page` is clamped rather than trusted: deleting the last drive on the last
 * page leaves the caller's page index pointing past the end, and an
 * out-of-range page renders an empty list under a pager that says there are
 * drives — which reads as the list having broken.
 */
export function resolveFolderListPage(params: {
  total: number;
  page: number;
  pageSize?: number;
}): FolderListPage {
  const pageSize = Math.max(1, params.pageSize ?? FOLDER_LIST_PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(params.total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(params.page) || 1), totalPages);
  const start = (page - 1) * pageSize;

  return {
    page,
    totalPages,
    start,
    end: Math.min(start + pageSize, params.total),
    // One page of drives needs no pager; drawing one would add a control
    // that can only ever say "1 of 1".
    showPager: params.total > pageSize,
  };
}
