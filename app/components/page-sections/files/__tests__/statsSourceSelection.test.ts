/**
 * Stats Source Selection Tests
 *
 * Verify the FilesContainer logic that decides whether to show
 * indexer-based stats (top-level "All" view) or local-computed stats
 * (folder tab / search / filter active).
 *
 * This is the core logic that keeps Home and Files page stats consistent.
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
  localFiles: Array<{
    size?: number;
    isFolder?: boolean;
    fileCount?: number;
  }>;
}

/**
 * Mirrors the formattedStorageSize useMemo in FilesContainer.
 * Returns the storage size string that would be displayed.
 */
function resolveStorageSize(input: StatsSourceInput): string {
  if (input.isRecentFiles) return "";

  // Folder-scoped: use local sum
  if (input.selectedFolderTab) {
    const tabSize = input.localFiles.reduce(
      (sum, f) => sum + BigInt(f.size ?? 0),
      BigInt(0)
    );
    if (tabSize === BigInt(0)) return "0 B";
    return formatBytes(Number(tabSize), 2);
  }

  // Top-level: use indexer
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
  const useLocalCount =
    input.selectedFolderTab ||
    input.searchTerm ||
    input.activeFiltersLength > 0;

  if (!useLocalCount && input.remoteFileCount !== undefined) {
    return input.remoteFileCount;
  }

  return input.localFiles.reduce((count, item) => {
    if (item.isFolder) {
      const nested = item.fileCount ?? 0;
      return count + (nested > 0 ? nested : 1);
    }
    return count + 1;
  }, 0);
}

// ─── Tests ──────────────────────────────────────────────────────

const defaults: StatsSourceInput = {
  isRecentFiles: false,
  selectedFolderTab: null,
  searchTerm: "",
  activeFiltersLength: 0,
  remoteFileCount: 42,
  remoteStorageTotalBytes: 5000000000,
  localFiles: [
    { size: 1000, isFolder: false },
    { size: 2000, isFolder: false },
    { size: 3000, isFolder: true, fileCount: 5 },
  ],
};

describe("Storage Size Source Selection", () => {
  it("uses indexer stats at top level (All view)", () => {
    const result = resolveStorageSize(defaults);
    // 5 GB from indexer
    expect(result).toBe("5 GB");
  });

  it("uses local stats when folder tab is selected", () => {
    const result = resolveStorageSize({
      ...defaults,
      selectedFolderTab: "Documents",
    });
    // 1000 + 2000 + 3000 = 6000 bytes = "6 KB"
    expect(result).toBe("6 KB");
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
      remoteStorageTotalBytes: 1500000000000, // 1.5 TB
    });
    expect(result).toBe("1.5 TB");
  });
});

describe("File Count Source Selection", () => {
  it("uses indexer count at top level (All view)", () => {
    const result = resolveFileCount(defaults);
    expect(result).toBe(42); // from remoteFileCount
  });

  it("uses local count when folder tab is selected", () => {
    const result = resolveFileCount({
      ...defaults,
      selectedFolderTab: "Documents",
    });
    // 1 file + 1 file + 5 (folder contents) = 7
    expect(result).toBe(7);
  });

  it("uses local count when search is active", () => {
    const result = resolveFileCount({
      ...defaults,
      searchTerm: "report",
    });
    // Falls back to local: 1 + 1 + 5 = 7
    expect(result).toBe(7);
  });

  it("uses local count when filters are active", () => {
    const result = resolveFileCount({
      ...defaults,
      activeFiltersLength: 2,
    });
    // Falls back to local: 1 + 1 + 5 = 7
    expect(result).toBe(7);
  });

  it("uses local count when indexer data is undefined", () => {
    const result = resolveFileCount({
      ...defaults,
      remoteFileCount: undefined,
    });
    // Falls back to local: 1 + 1 + 5 = 7
    expect(result).toBe(7);
  });

  it("uses indexer count of 0 when it returns 0", () => {
    const result = resolveFileCount({
      ...defaults,
      remoteFileCount: 0,
    });
    // 0 is a valid indexer response, should use it
    expect(result).toBe(0);
  });

  it("counts empty folders as 1 item", () => {
    const result = resolveFileCount({
      ...defaults,
      selectedFolderTab: "Stuff",
      localFiles: [
        { size: 100, isFolder: true, fileCount: 0 },
        { size: 200, isFolder: false },
      ],
    });
    // Empty folder = 1, file = 1, total = 2
    expect(result).toBe(2);
  });

  it("handles empty local file list", () => {
    const result = resolveFileCount({
      ...defaults,
      selectedFolderTab: "Empty",
      localFiles: [],
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
