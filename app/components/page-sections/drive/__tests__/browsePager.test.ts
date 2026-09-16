import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const container = readFileSync(join(here, "../DriveContainer.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/**
 * The browsed file list pages; the search result that replaces it does not.
 *
 * A filter swaps the whole view for a server-side search spanning every
 * nested folder (`useDriveScopedSearch` for a remote drive,
 * `useRecursiveFileSearch` for a local one). Paging that would be paging a
 * different dataset than the pager's count describes, so the pager is gated
 * off while a filter is active.
 */
describe("the browse pager", () => {
  it("is hidden while a filter is active", () => {
    expect(container).toMatch(
      /browsePagingActive =[\s\S]{0,120}!hasActiveSearchOrFilter/,
    );
    expect(container).toMatch(/showBrowsePager = browsePagingActive/);
  });

  // Recent Files is a synthetic cross-drive merge with no level to page.
  it("is hidden on Recent Files", () => {
    expect(container).toMatch(/browsePagingActive =[\s\S]{0,120}!isRecentFiles/);
  });

  // The drive ROOT was excluded from paging, which is why the main Drive
  // page had no pager and kept growing as the reader scrolled.
  it("covers the drive root, not only folders", () => {
    expect(container).not.toMatch(
      /showBrowsePager[\s\S]{0,120}\(isNested \|\| isRemoteRoot\)/,
    );
  });

  // Paging replaces reveal-on-scroll; running both slices the page twice
  // and leaves the sentinel appending under the pager.
  it("renders the page rather than the scroll window", () => {
    expect(container).toMatch(/displayedData=\{browsePageRows \?\? visibleData\}/);
    expect(container).toMatch(/hasMore=\{browsePagingActive \? false/);
  });

  // The table sorts the whole level and renders a WINDOW of the sorted
  // order. Under reveal-on-scroll that window always began at 0 and only
  // grew, so its length described it. A page MOVES the window, and a start
  // stuck at 0 renders page one's rows on every page: the level sorts
  // correctly and the reader sees the same fifteen rows regardless. That is
  // what made sorting look broken.
  it("tells the table where the page starts, not just how long it is", () => {
    expect(container).toMatch(/windowStart=\{browseWindowStart\}/);
    expect(container).toMatch(
      /browseWindowStart =[\s\S]{0,200}\(browsePage - 1\) \* browsePageSize/,
    );
  });

  // A server-paged remote level is handed only its own page as `allFiles`,
  // so its window starts at 0. Offsetting into a one-page list renders
  // nothing.
  it("starts at zero when the server already paged the level", () => {
    expect(container).toMatch(
      /browseWindowStart =\s*\n?\s*!browsePagingActive \|\| browsePagedOnServer/,
    );
  });

  // The skeleton stands in for a page, so it is the height of one.
  it("sizes the loading skeleton to the page", () => {
    expect(container).toMatch(
      /skeletonRows=\{browsePagingActive \? browsePageSize/,
    );
  });

  // One page is not worth a control.
  it("is hidden when everything fits on one page", () => {
    expect(container).toMatch(/showBrowsePager[\s\S]{0,240}browseTotalPages > 1/);
  });

  // The level's own size, not the rows currently in hand: a remote level
  // reports the server's count, so the last page is known without walking
  // to it.
  // A server-paged remote level reports its own size; every other view
  // holds all of its rows, so the list is the count.
  it("counts the level either from the server or from the rows in hand", () => {
    expect(container).toMatch(
      /browseTotalItems = browsePagedOnServer[\s\S]{0,160}nestedListing\.totalCount[\s\S]{0,80}statusFilteredData\.length/,
    );
    expect(container).toMatch(/browseTotalPages[\s\S]{0,160}Math\.ceil/);
  });

  it("feeds the page straight to the listing hook", () => {
    expect(container).toMatch(/useNestedFolderListing\({[\s\S]{0,400}page: browsePage/);
    expect(container).toMatch(/useNestedFolderListing\({[\s\S]{0,400}pageSize: browsePageSize/);
  });

  // Page 4 of a folder the user just opened is a window they did not ask
  // for, and for a shorter folder it is a window that does not exist.
  it("returns to page 1 when the browsed level changes", () => {
    expect(container).toContain("lastBrowseLevelRef");
    expect(container).toMatch(/lastBrowseLevelRef[\s\S]{0,200}setBrowsePage\(1\)/);
  });

  // A new size changes which rows page 1 holds, so the old page number
  // means something else.
  it("returns to page 1 when the page size changes", () => {
    expect(container).toMatch(
      /handleBrowsePageSizeChange[\s\S]{0,200}setBrowsePage\(1\)/,
    );
  });
});
