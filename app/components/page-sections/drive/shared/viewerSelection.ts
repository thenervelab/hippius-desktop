import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

/**
 * The media viewer's selection: the open file plus the sibling list it was
 * opened from. The two are stored as one value so they can never desync —
 * a file opened from an inline-expanded folder must be paired with that
 * folder's rows (its thumbnail rail / prev-next walk them), while a
 * top-level open carries `previewList: null` and the viewer falls back to
 * the page's own list.
 */
export interface ViewerSelection {
  file: FormattedUserFile | null;
  previewList: FormattedUserFile[] | null;
}

export const EMPTY_VIEWER_SELECTION: ViewerSelection = {
  file: null,
  previewList: null,
};

/**
 * Computes the next viewer selection for an open/navigate/close action.
 *
 * Invariants this pins down:
 * - Closing (`file === null`) always clears the preview list, so a later
 *   top-level open can never inherit a stale nested-folder list.
 * - An open without an explicit list resolves to `previewList: null` (page
 *   fallback) — it never keeps the previous list, which would wrongly scope
 *   a top-level file to whatever folder was previewed before it.
 * - Navigation inside the viewer preserves scope by re-passing the current
 *   list explicitly (the caller closes over it), not by implicit retention.
 */
export function nextViewerSelection(
  file: FormattedUserFile | null,
  previewList: FormattedUserFile[] | null = null,
): ViewerSelection {
  if (!file) return EMPTY_VIEWER_SELECTION;
  return { file, previewList };
}
