import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

/**
 * "Show in folder" points the file out: once its folder is open and listed,
 * the Drive page moves to the page that holds the file, scrolls its row (or
 * card) into view and highlights it for a few seconds. A folder of forty
 * captures is otherwise a hunt for the one just taken.
 *
 * Pure, so each step is unit-tested; `useDriveHighlight` applies them.
 */

/** How long the highlight stays before it has faded. */
export const HIGHLIGHT_MS = 3600;
/**
 * How long to keep looking for a file the listing does not hold yet. A
 * capture's card offers Show in folder as soon as the file is written, and
 * the listing that opens first can predate it.
 */
export const HIGHLIGHT_WAIT_MS = 8000;
/** How often the listing is asked again while waiting. */
export const HIGHLIGHT_RETRY_EVERY_MS = 1500;
/**
 * The longest a request waits for its folder to open at all. Past it the
 * request is dropped, so it cannot point a file out later, when the user
 * browses to that folder on their own.
 */
export const HIGHLIGHT_OPEN_LIMIT_MS = 30000;

/** The attribute every top-level row and card carries: its `entryKey`. */
export const ENTRY_ATTRIBUTE = "data-drive-entry";
/** Set on the element being pointed out; `globals.css` draws and fades it. */
export const HIGHLIGHT_ATTRIBUTE = "data-drive-highlight";

const nfc = (value: string | null | undefined) => (value ?? "").normalize("NFC");
const trimSlashes = (path: string) => path.replace(/^\/+|\/+$/g, "");

/** A file to point out once `folder` of the drive `label` is on screen. */
export interface HighlightRequest {
  label: string;
  /** Drive-relative folder path; "" is the drive's root. */
  folder: string;
  name: string;
  /** Give up after this time (ms since the epoch). */
  until: number;
}

/**
 * Whether `file` is the file called `name`. Exact, never trimmed, in one
 * Unicode form (macOS hands out decomposed names), the same comparison
 * `folderUrlForPath` makes for folders. A folder is never the file.
 */
export function isEntryNamed(file: FormattedUserFile, name: string): boolean {
  if (file.isFolder) return false;
  const wanted = nfc(name);
  return nfc(file.actualFileName) === wanted || nfc(file.name) === wanted;
}

/** What a row or card carries in `ENTRY_ATTRIBUTE`, to be found again. */
export function entryKey(file: FormattedUserFile): string {
  return nfc(file.actualFileName || file.name);
}

export function findEntryIndex(rows: readonly FormattedUserFile[], name: string): number {
  return rows.findIndex((f) => isEntryNamed(f, name));
}

/** The 1-based page that holds the row at `index`. */
export function pageForIndex(index: number, pageSize: number): number {
  return Math.floor(Math.max(0, index) / Math.max(1, pageSize)) + 1;
}

/** Whether the level on screen is the one the request is for. */
export function isRequestedLevel(
  request: HighlightRequest,
  view: { label: string | null; folder: string | null },
): boolean {
  if (view.label === null || view.folder === null) return false;
  return (
    nfc(view.label) === nfc(request.label) &&
    nfc(trimSlashes(view.folder)) === nfc(trimSlashes(request.folder))
  );
}

export type HighlightStep =
  /** On the page on screen: point it out. */
  | { kind: "show"; file: FormattedUserFile }
  /** Listed, on another page: go there first. */
  | { kind: "page"; page: number }
  /** A server-paged level holds one page: ask Rust which page lists it. */
  | { kind: "locate" }
  /** Not listed (yet): look again when the listing refreshes. */
  | { kind: "wait" }
  /** Waited long enough: stop quietly. */
  | { kind: "give-up" };

/**
 * The next step for a request, given the level on screen.
 *
 * `ordered` is the level in the order it is shown: the whole level for a
 * local one (sorted as the table sorts it), the page in hand for a
 * server-paged one. `page` is the page on screen, and `paged` whether the
 * level is paged at all (a filter shows a search result instead).
 */
export function nextHighlightStep(
  request: HighlightRequest,
  view: {
    ordered: readonly FormattedUserFile[];
    serverPaged: boolean;
    paged: boolean;
    page: number;
    pageSize: number;
    now: number;
  },
): HighlightStep {
  const index = findEntryIndex(view.ordered, request.name);
  if (index >= 0) {
    // A server page is the page on screen; a local level is whole and
    // shown a page at a time.
    if (!view.paged || view.serverPaged) return { kind: "show", file: view.ordered[index] };
    const page = pageForIndex(index, view.pageSize);
    return page === view.page ? { kind: "show", file: view.ordered[index] } : { kind: "page", page };
  }
  if (view.now >= request.until) return { kind: "give-up" };
  return view.serverPaged && view.paged ? { kind: "locate" } : { kind: "wait" };
}

/**
 * What to do with the page Rust found for a server-paged level: go there,
 * or (when it names the page already on screen, whose listing predates the
 * file) wait for the listing to refresh.
 */
export function stepForLocatedPage(located: number | null, page: number): HighlightStep {
  if (located === null || located === page) return { kind: "wait" };
  return { kind: "page", page: located };
}
