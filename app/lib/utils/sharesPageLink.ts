// Links into the /shares page that point at specific rows.
//
// The drive's link badge sends the user to /shares to manage a file's link.
// With many links the row is hard to find, so the badge names the rows it
// stands for in the query string and the page highlights them. The ids are
// the Active Shares table's row ids, so the page can match them without a
// lookup.

/** Query parameter holding the comma-separated row ids to highlight. */
export const SHARES_HIGHLIGHT_PARAM = "highlight";

/** Active Shares row id of a file share. */
export function fileShareRowId(shareToken: string): string {
  return `file:${shareToken}`;
}

/** Active Shares row id of a folder share. A folder row minted on another
 *  device has no plaintext token, but every row has its `tokenHash`. */
export function folderShareRowId(tokenHash: string): string {
  return `folder:${tokenHash}`;
}

/** `/shares`, highlighting `rowIds` when there are any. */
export function sharesPageHref(rowIds: readonly string[]): string {
  if (rowIds.length === 0) return "/shares";
  const value = encodeURIComponent(rowIds.join(","));
  return `/shares?${SHARES_HIGHLIGHT_PARAM}=${value}`;
}

/** The row ids named by the highlight parameter's value (empty when absent). */
export function parseSharesHighlight(value: string | null): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}
