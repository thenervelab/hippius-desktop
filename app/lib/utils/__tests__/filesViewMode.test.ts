import { describe, expect, it } from "vitest";
import {
  shouldRunInMemoryFilter,
  shouldUseRecursiveSearch,
} from "@/lib/utils/filesViewMode";

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
