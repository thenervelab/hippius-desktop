/**
 * The two bands the files table alternates between.
 *
 * Kept here rather than inline at both call sites: the row and the footer
 * beneath it have to agree about what the sequence is, and a second copy of
 * these classes is how they stop agreeing. Mirrors the `odd:`/`even:` pair on
 * the row in `files-table/index.tsx`.
 */
export const ROW_STRIPE = {
  odd: "bg-grey-light-200 dark:bg-black-500",
  even: "bg-grey-light-400 dark:bg-black-primary-bg",
} as const;

/**
 * The band the pager footer takes, so the stripe carries on past the last row.
 *
 * Rows are striped by nth-child, so where the sequence lands depends on how
 * many rows a page holds. A footer with one fixed tone is therefore right for
 * one page size and wrong for the next: at fifteen rows the last row was odd
 * and the footer read as the following band by accident, and at twenty the
 * last row is even so that same footer repeats it and the block ends on two
 * identical bands.
 *
 * The footer is row N+1, so an EVEN row count gives it the odd band.
 *
 * Derived from the rows actually on screen, not from the page size: the last
 * page is usually short of a full one, and it is the rendered count that
 * decides where the alternation stopped.
 */
export function pagerStripeClass(renderedRowCount: number): string {
  return renderedRowCount % 2 === 0 ? ROW_STRIPE.odd : ROW_STRIPE.even;
}
