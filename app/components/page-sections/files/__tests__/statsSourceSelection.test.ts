/**
 * Stats Source Selection Tests
 *
 * Verify the FilesContainer logic that decides whether to show
 * indexer-based stats (top-level "All" view) or per-tab aggregates
 * sourced from Rust (`labelStats`) for folder tabs, and a reduce
 * over the filtered list for search/filter active states.
 *
 * This mirror exists to regression-protect the display rules that
 * keep Home and Files page stats consistent.
 */
import { describe, it, expect } from "vitest";
import { formatBytes } from "@/app/lib/utils/formatBytes";

// ─── Extract the decision logic from FilesContainer for testability ──

interface StatsSourceInput {
  isRecentFiles: boolean;
  selectedFolderTab: string | null;
  searchTerm: string;
  activeFiltersLength: number;
  remoteFileCount: number | undefined;
  remoteStorageTotalBytes: number | undefined;
  /** Mirrors `UserFilesData.labelStats` — per-tab aggregates from Rust. */
  labelStats: Record<string, { totalBytes: number; fileCount: number }>;
  /** Used only for the search/filter branch (reduce over filtered list). */
  filteredFiles: Array<{ isFolder?: boolean; fileCount?: number }>;
}

/**
 * Mirrors the formattedStorageSize useMemo in FilesContainer.
 * Returns the storage size string that would be displayed.
 */
function resolveStorageSize(input: StatsSourceInput): string {
  if (input.isRecentFiles) return "";

  if (input.selectedFolderTab) {
    const bytes = input.labelStats[input.selectedFolderTab]?.totalBytes ?? 0;
    return formatBytes(bytes, 2);
  }

  if (input.remoteStorageTotalBytes) {
    return formatBytes(input.remoteStorageTotalBytes, 2);
  }

  return "0 B";
}

/**
 * Mirrors the displayedFileCount useMemo in FilesContainer.
 * Returns the file count that would be displayed.
 */
function resolveFileCount(input: StatsSourceInput): number {
  if (input.searchTerm || input.activeFiltersLength > 0) {
    return input.filteredFiles.reduce((count, item) => {
      if (item.isFolder) {
        return count + (item.fileCount ?? 0);
      }
      return count + 1;
    }, 0);
  }

  if (input.selectedFolderTab) {
    return input.labelStats[input.selectedFolderTab]?.fileCount ?? 0;
  }

  if (input.remoteFileCount !== undefined) {
    return input.remoteFileCount;
  }

  return 0;
}

// ─── Tests ──────────────────────────────────────────────────────

const defaults: StatsSourceInput = {
  isRecentFiles: false,
  selectedFolderTab: null,
  searchTerm: "",
  activeFiltersLength: 0,
  remoteFileCount: 42,
  remoteStorageTotalBytes: 5_000_000_000,
  labelStats: {
    Documents: { totalBytes: 6_000, fileCount: 7 },
  },
  filteredFiles: [
    { isFolder: false },
    { isFolder: false },
    // Folder with 6 nested files — intentionally ≠ labelStats.Documents.fileCount (7)
    // so the search/filter branch and the folder-tab branch return distinct
    // numbers. If a regression reroutes search to labelStats (or vice versa),
    // the assertion below flips instead of silently agreeing with the other path.
    { isFolder: true, fileCount: 6 },
  ],
};

describe("Storage Size Source Selection", () => {
  it("uses indexer stats at top level (All view)", () => {
    const result = resolveStorageSize(defaults);
    // 5 GB from indexer
    expect(result).toBe("5 GB");
  });

  it("uses labelStats bytes when a folder tab is selected", () => {
    const result = resolveStorageSize({ ...defaults, selectedFolderTab: "Documents" });
    // 6 KB from labelStats.Documents.totalBytes
    expect(result).toBe("6 KB");
  });

  it("returns '0 B' when the folder tab is absent from labelStats", () => {
    // Mirrors the `?? 0` defensive fallback in FilesContainer's
    // formattedStorageSize — a folder tab that hasn't had its stats
    // populated yet should render "0 B", not throw or show stale data.
    const result = resolveStorageSize({
      ...defaults,
      selectedFolderTab: "DoesNotExist",
      labelStats: {},
    });
    expect(result).toBe("0 B");
  });

  it("returns empty for recent files view", () => {
    const result = resolveStorageSize({
      ...defaults,
      isRecentFiles: true,
    });
    expect(result).toBe("");
  });

  it("returns '0 B' when indexer has no data and no folder selected", () => {
    const result = resolveStorageSize({
      ...defaults,
      remoteStorageTotalBytes: undefined,
    });
    expect(result).toBe("0 B");
  });

  it("returns '0 B' when indexer reports 0 bytes", () => {
    const result = resolveStorageSize({
      ...defaults,
      remoteStorageTotalBytes: 0,
    });
    expect(result).toBe("0 B");
  });

  it("handles large indexer values", () => {
    const result = resolveStorageSize({
      ...defaults,
      remoteStorageTotalBytes: 1_500_000_000_000, // 1.5 TB
    });
    expect(result).toBe("1.5 TB");
  });
});

describe("File Count Source Selection", () => {
  it("uses indexer count at top level (All view)", () => {
    const result = resolveFileCount(defaults);
    expect(result).toBe(42); // from remoteFileCount
  });

  it("uses labelStats when a folder tab is selected", () => {
    const result = resolveFileCount({ ...defaults, selectedFolderTab: "Documents" });
    // Comes directly from labelStats.Documents.fileCount
    expect(result).toBe(7);
  });

  it("uses filtered-list count when search is active", () => {
    const result = resolveFileCount({ ...defaults, searchTerm: "report" });
    // 1 file + 1 file + 6 (folder recursive) = 8 — note this is 8, not
    // labelStats.Documents.fileCount (7). Search must NOT reach into labelStats.
    expect(result).toBe(8);
  });

  it("uses filtered-list count when filters are active", () => {
    const result = resolveFileCount({ ...defaults, activeFiltersLength: 2 });
    expect(result).toBe(8);
  });

  it("returns 0 when indexer data is undefined and no folder tab is selected", () => {
    const result = resolveFileCount({ ...defaults, remoteFileCount: undefined });
    // No tab, no indexer, no search — header just shows 0.
    expect(result).toBe(0);
  });

  it("uses indexer count of 0 when it returns 0", () => {
    const result = resolveFileCount({
      ...defaults,
      remoteFileCount: 0,
    });
    // 0 is a valid indexer response, should use it
    expect(result).toBe(0);
  });

  it("counts empty folders as 0 files (no +1 fallback)", () => {
    const result = resolveFileCount({
      ...defaults,
      selectedFolderTab: "Stuff",
      labelStats: { Stuff: { totalBytes: 100, fileCount: 0 } },
    });
    // Empty folder contributes 0 — a folder with no files is not a file.
    expect(result).toBe(0);
  });

  it("returns 0 when the folder tab is absent from labelStats", () => {
    const result = resolveFileCount({
      ...defaults,
      selectedFolderTab: "DoesNotExist",
      labelStats: {},
    });
    expect(result).toBe(0);
  });
});

describe("Home/Files consistency contract", () => {
  it("same indexer response → same file count on both pages", () => {
    // Home page uses useFilesCount → returns remoteFileCount directly
    const homePageCount = defaults.remoteFileCount;

    // Files page (All view) uses same hook
    const filesPageCount = resolveFileCount(defaults);

    expect(filesPageCount).toBe(homePageCount);
  });

  it("same indexer response → same storage size on both pages", () => {
    // Home page formats: formatBytes(remoteStats.totalBytes, 2)
    const homePageSize = formatBytes(defaults.remoteStorageTotalBytes!, 2);

    // Files page (All view) formats same way
    const filesPageSize = resolveStorageSize(defaults);

    expect(filesPageSize).toBe(homePageSize);
  });

  it("diverges correctly when folder tab is selected (expected)", () => {
    const homePageCount = defaults.remoteFileCount;
    const filesPageCount = resolveFileCount({
      ...defaults,
      selectedFolderTab: "Documents",
    });

    // These SHOULD differ — folder-scoped is a subset
    expect(filesPageCount).not.toBe(homePageCount);
  });
});
