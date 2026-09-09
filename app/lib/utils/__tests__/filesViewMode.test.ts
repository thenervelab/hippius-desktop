import { describe, expect, it } from "vitest";
import {
  filterCriteriaAreActive,
  shouldRunInMemoryFilter,
  shouldUseDriveScopedSearch,
  shouldUseRecursiveSearch,
} from "@/lib/utils/filesViewMode";

describe("filterCriteriaAreActive", () => {
  it("treats the Excluded chip alone as an active filter", () => {
    expect(filterCriteriaAreActive({ excludedOnly: true })).toBe(true);
    expect(filterCriteriaAreActive({})).toBe(false);
    expect(filterCriteriaAreActive({ searchTerm: "  " })).toBe(false);
    expect(filterCriteriaAreActive({ fileSizes: [] })).toBe(false);
  });
});

describe("filesViewMode", () => {
  it("uses recursive search when a filter is active on a drive", () => {
    expect(
      shouldUseRecursiveSearch({
        hasActiveSearchOrFilter: true,
        recursiveSearchLabel: "docs",
        isRecentFiles: false,
      }),
    ).toBe(true);
    expect(
      shouldRunInMemoryFilter({
        hasActiveSearchOrFilter: true,
        recursiveSearchLabel: "docs",
        isRecentFiles: false,
      }),
    ).toBe(false);
  });

  it("does not use recursive search on recent files", () => {
    expect(
      shouldUseRecursiveSearch({
        hasActiveSearchOrFilter: true,
        recursiveSearchLabel: "docs",
        isRecentFiles: true,
      }),
    ).toBe(false);
    expect(
      shouldRunInMemoryFilter({
        hasActiveSearchOrFilter: true,
        recursiveSearchLabel: "docs",
        isRecentFiles: true,
      }),
    ).toBe(true);
  });

  it("does not use recursive search without a drive label", () => {
    expect(
      shouldUseRecursiveSearch({
        hasActiveSearchOrFilter: true,
        recursiveSearchLabel: null,
        isRecentFiles: false,
      }),
    ).toBe(false);
  });
});

describe("shouldUseDriveScopedSearch", () => {
  const base = {
    hasActiveSearchOrFilter: true,
    isRemoteView: true,
    remoteLabel: "Camera Uploads",
    isRecentFiles: false,
  };

  // The recursive search walks local disk, which a browsed drive has none
  // of — so without this the page could only filter the rows on screen and
  // missed every subfolder.
  it("searches the server for a drive this device does not sync", () => {
    expect(shouldUseDriveScopedSearch(base)).toBe(true);
  });

  it("leaves a local drive to the recursive search", () => {
    expect(shouldUseDriveScopedSearch({ ...base, isRemoteView: false })).toBe(false);
  });

  it("does not fire with nothing typed", () => {
    expect(
      shouldUseDriveScopedSearch({ ...base, hasActiveSearchOrFilter: false }),
    ).toBe(false);
  });

  // Without a label there is no drive to scope to, and an unscoped search
  // would silently return the whole account.
  it("does not fire without a drive to scope to", () => {
    expect(shouldUseDriveScopedSearch({ ...base, remoteLabel: null })).toBe(false);
  });

  it("never fires on Recent Files, which is not one drive", () => {
    expect(shouldUseDriveScopedSearch({ ...base, isRecentFiles: true })).toBe(false);
  });
});
