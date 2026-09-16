import { describe, expect, it } from "vitest";
import {
  filterCriteriaAreActive,
  isDriveFolderListView,
  isNestedFolderView,
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

describe("isNestedFolderView", () => {
  it("is a folder only when the URL names one", () => {
    expect(
      isNestedFolderView({ folderName: "Drive", subFolderPath: "Documents" }),
    ).toBe(true);
  });

  it("is the drive root when neither param is set", () => {
    expect(isNestedFolderView({ folderName: null, subFolderPath: null })).toBe(
      false,
    );
  });

  // Half a link is not a folder: showing an empty folder for one is worse
  // than staying on the root the user can actually use.
  it("needs both params, not either", () => {
    expect(
      isNestedFolderView({ folderName: "Drive", subFolderPath: null }),
    ).toBe(false);
    expect(
      isNestedFolderView({ folderName: null, subFolderPath: "Documents" }),
    ).toBe(false);
    expect(isNestedFolderView({ folderName: "", subFolderPath: "" })).toBe(false);
  });
});

describe("isDriveFolderListView", () => {
  const view = (over: Partial<Parameters<typeof isDriveFolderListView>[0]> = {}) =>
    isDriveFolderListView({
      isOnLocalView: true,
      isNested: false,
      isRecentFiles: false,
      ...over,
    });

  it("is the drive root, where the plan card belongs", () => {
    expect(view()).toBe(true);
  });

  // The regression this exists for. Opening a synced drive from the folder
  // list clears `isOnLocalView` and changes no URL, so a check that only
  // looked for nested URL params reported the folder list while the drive's
  // contents were on screen, and the plan card stayed up one level in.
  it("is false inside a drive, even though the URL never changed", () => {
    expect(view({ isOnLocalView: false, isNested: false })).toBe(false);
  });

  // A link opened straight into a subfolder arrives with `isOnLocalView`
  // still at its initial true, so the nested flag has to be consulted too.
  it("is false for a link opened straight into a subfolder", () => {
    expect(view({ isOnLocalView: true, isNested: true })).toBe(false);
  });

  it("is false on Recent Files, which is a listing rather than the root", () => {
    expect(view({ isRecentFiles: true })).toBe(false);
  });
});
