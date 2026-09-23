import { describe, expect, it } from "vitest";
import {
  DEFAULT_BROWSE_PAGE_SIZE,
  MAX_BROWSE_PAGE_SIZE,
  normalizeBrowsePageSize,
  shouldShowBrowsePager,
} from "@/app/components/page-sections/drive/browsePager";

const show = (over: Partial<Parameters<typeof shouldShowBrowsePager>[0]> = {}) =>
  shouldShowBrowsePager({
    pagingActive: true,
    totalPages: 1,
    pageSize: DEFAULT_BROWSE_PAGE_SIZE,
    ...over,
  });

describe("when the browse pager is drawn", () => {
  it("is drawn once the level outgrows a page", () => {
    expect(show({ totalPages: 2 })).toBe(true);
  });

  it("stays hidden on a small folder at the default size", () => {
    // Nothing to reach and nothing to undo: a pager here is noise.
    expect(show({ totalPages: 1 })).toBe(false);
  });

  /**
   * The bug this rule exists for. The size control lives inside the pager, so
   * a reader who picks 50 and opens a folder of 40 files lost the only way
   * back to 20 — on that folder and every smaller one after it.
   */
  it("stays drawn on one page once the reader has chosen a size", () => {
    expect(show({ totalPages: 1, pageSize: 50 })).toBe(true);
    expect(show({ totalPages: 1, pageSize: 10 })).toBe(true);
  });

  it("hides again when the size goes back to the default", () => {
    expect(show({ totalPages: 1, pageSize: DEFAULT_BROWSE_PAGE_SIZE })).toBe(false);
  });

  // A filter swaps the view for a cross-folder search result, and Recent
  // Files is a synthetic merge: neither is the level this pager counts.
  it("is never drawn where paging does not apply", () => {
    expect(show({ pagingActive: false, totalPages: 9, pageSize: 50 })).toBe(false);
  });

  it("takes the default it compares against from the caller", () => {
    expect(show({ totalPages: 1, pageSize: 25, defaultPageSize: 25 })).toBe(false);
    expect(show({ totalPages: 1, pageSize: 20, defaultPageSize: 25 })).toBe(true);
  });
});

/**
 * Storage is a string typed by nobody. A zero or a NaN reaching the page
 * maths divides the level into an infinite page count; a huge one opens the
 * drive with every row in the DOM.
 */
describe("restoring a remembered page size", () => {
  it("keeps a sensible stored size", () => {
    expect(normalizeBrowsePageSize("50")).toBe(50);
    expect(normalizeBrowsePageSize(100)).toBe(100);
  });

  it("falls back to the default when nothing is stored", () => {
    expect(normalizeBrowsePageSize(null)).toBe(DEFAULT_BROWSE_PAGE_SIZE);
    expect(normalizeBrowsePageSize(undefined)).toBe(DEFAULT_BROWSE_PAGE_SIZE);
    expect(normalizeBrowsePageSize("")).toBe(DEFAULT_BROWSE_PAGE_SIZE);
  });

  it("refuses a size that would break the page maths", () => {
    expect(normalizeBrowsePageSize("0")).toBe(DEFAULT_BROWSE_PAGE_SIZE);
    expect(normalizeBrowsePageSize("-5")).toBe(DEFAULT_BROWSE_PAGE_SIZE);
    expect(normalizeBrowsePageSize("abc")).toBe(DEFAULT_BROWSE_PAGE_SIZE);
    expect(normalizeBrowsePageSize("20.5")).toBe(DEFAULT_BROWSE_PAGE_SIZE);
  });

  it("refuses a size that would render the whole drive at once", () => {
    expect(normalizeBrowsePageSize(String(MAX_BROWSE_PAGE_SIZE + 1))).toBe(DEFAULT_BROWSE_PAGE_SIZE);
    expect(normalizeBrowsePageSize("1e9")).toBe(DEFAULT_BROWSE_PAGE_SIZE);
    expect(normalizeBrowsePageSize(MAX_BROWSE_PAGE_SIZE)).toBe(MAX_BROWSE_PAGE_SIZE);
  });

  it("takes the caller's fallback when one is given", () => {
    expect(normalizeBrowsePageSize("nonsense", 25)).toBe(25);
  });
});
