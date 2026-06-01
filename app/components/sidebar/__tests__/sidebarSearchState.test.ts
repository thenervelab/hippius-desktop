import { describe, expect, it } from "vitest";
import {
  getSidebarSearchView,
  type SidebarSearchViewInput,
} from "../sidebarSearchState";

const base: SidebarSearchViewInput = {
  hasQuery: false,
  isFetching: false,
  resultCount: 0,
  recentLoading: false,
  recentCount: 0,
};

describe("getSidebarSearchView", () => {
  // --- empty query → recent-uploads branch ---
  it("shows recent uploads when the query is empty and recents exist", () => {
    expect(getSidebarSearchView({ ...base, recentCount: 7 })).toBe("recent");
  });

  it("prefers cached recents over the loading state during a refetch", () => {
    expect(
      getSidebarSearchView({ ...base, recentCount: 3, recentLoading: true }),
    ).toBe("recent");
  });

  it("shows the recent loading state when nothing is cached yet", () => {
    expect(getSidebarSearchView({ ...base, recentLoading: true })).toBe(
      "recent-loading",
    );
  });

  it("shows the recent empty state once recents settle with no rows", () => {
    expect(getSidebarSearchView(base)).toBe("recent-empty");
  });

  // --- active query → search branch ---
  it("shows results when a query has matches", () => {
    expect(
      getSidebarSearchView({ ...base, hasQuery: true, resultCount: 5 }),
    ).toBe("results");
  });

  it("prefers results over the skeleton while a refetch is in flight", () => {
    expect(
      getSidebarSearchView({
        ...base,
        hasQuery: true,
        resultCount: 5,
        isFetching: true,
      }),
    ).toBe("results");
  });

  it("shows the skeleton while fetching with no results yet", () => {
    expect(
      getSidebarSearchView({ ...base, hasQuery: true, isFetching: true }),
    ).toBe("skeleton");
  });

  it("shows no-results once a query settles with zero matches", () => {
    expect(getSidebarSearchView({ ...base, hasQuery: true })).toBe(
      "no-results",
    );
  });

  // The query branch ignores recent-uploads inputs entirely, and the
  // empty-query branch ignores search inputs — guards against a future edit
  // crossing the two source's signals.
  it("ignores recent signals while a query is active", () => {
    expect(
      getSidebarSearchView({
        ...base,
        hasQuery: true,
        resultCount: 2,
        recentCount: 9,
        recentLoading: true,
      }),
    ).toBe("results");
  });
});
