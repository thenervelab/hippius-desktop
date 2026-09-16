// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { useNestedFolderListing } from "../use-nested-folder-listing";

const entry = (name: string, isFolder = false) => ({
  name,
  is_folder: isFolder,
  size: 1,
  modified: 0,
  sync_status: "synced",
  arion_hash: `h-${name}`,
});

/**
 * A remote level of `total` files, answering whatever window is asked for.
 *
 * Routes by command name and tolerates an argument-less call, because the
 * hook is not the only thing on this mock.
 */
function remoteServer(total: number) {
  return (cmd: string, args?: Record<string, number>) => {
    if (cmd !== "list_remote_folder_grouped") return Promise.resolve(null);
    const offset = args?.offset ?? 0;
    const limit = args?.limit ?? total;
    const files = Array.from({ length: total }, (_, i) => entry(`f${i}`));
    const window = files.slice(offset, offset + limit);
    return Promise.resolve({
      folders: [],
      files: window,
      hasMore: offset + window.length < total,
      totalCount: total,
    });
  };
}

const remoteOpts = {
  accountId: "acct",
  syncPath: null,
  subfolder: null,
  label: "drive",
  enabled: true,
  remote: true,
};

describe("useNestedFolderListing paging", () => {
  beforeEach(() => invoke.mockReset());

  it("asks the server for the requested window, not always the first", async () => {
    invoke.mockImplementation(remoteServer(120) as never);

    const { result } = renderHook(() =>
      useNestedFolderListing({ ...remoteOpts, page: 3, pageSize: 15 }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // Page 3 of 15 starts at offset 30.
    expect(invoke).toHaveBeenCalledWith(
      "list_remote_folder_grouped",
      expect.objectContaining({ offset: 30, limit: 15 }),
    );
    expect(result.current.data).toHaveLength(15);
    expect(result.current.data[0].name).toBe("f30");
  });

  it("reports the server's total so the pager knows the last page", async () => {
    invoke.mockImplementation(remoteServer(120) as never);
    const { result } = renderHook(() =>
      useNestedFolderListing({ ...remoteOpts, page: 1, pageSize: 15 }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.totalCount).toBe(120);
  });

  // The pager owns navigation while paging; a sentinel appending the next
  // page underneath would put two pages in one view.
  it("stops offering scroll-driven loading while paged", async () => {
    invoke.mockImplementation(remoteServer(120) as never);
    const { result } = renderHook(() =>
      useNestedFolderListing({ ...remoteOpts, page: 1, pageSize: 15 }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.hasMore).toBe(false);
  });

  // The default path is what ExpandedFolderRows uses, and it must not change.
  it("keeps lazy loading when no page is supplied", async () => {
    invoke.mockImplementation(remoteServer(120) as never);
    const { result } = renderHook(() => useNestedFolderListing(remoteOpts));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.hasMore).toBe(true);
    expect(invoke).toHaveBeenCalledWith(
      "list_remote_folder_grouped",
      expect.objectContaining({ offset: 0 }),
    );
  });

  it("re-fetches when the page changes", async () => {
    invoke.mockImplementation(remoteServer(120) as never);
    const { result, rerender } = renderHook(
      ({ page }) => useNestedFolderListing({ ...remoteOpts, page, pageSize: 15 }),
      { initialProps: { page: 1 } },
    );
    await waitFor(() => expect(result.current.data[0]?.name).toBe("f0"));

    rerender({ page: 2 });
    await waitFor(() => expect(result.current.data[0]?.name).toBe("f15"));
  });

  it("returns a local level whole, and re-fetches nothing on a page change", () => {
    // The hook does NOT slice local rows. The container owns the one slice,
    // because it also pages the drive root, which this hook never sees, and
    // two slices took the page twice.
    invoke.mockResolvedValue({
      folders: [],
      files: Array.from({ length: 40 }, (_, i) => entry(`l${i}`)),
    } as never);

    const { result, rerender } = renderHook(
      ({ page }) =>
        useNestedFolderListing({
          accountId: "acct",
          syncPath: "/tmp/drive",
          subfolder: null,
          label: "drive",
          enabled: true,
          page,
          pageSize: 15,
        }),
      { initialProps: { page: 1 } },
    );

    return waitFor(() => expect(result.current.isLoading).toBe(false)).then(
      async () => {
        expect(result.current.data).toHaveLength(40);
        expect(result.current.totalCount).toBe(40);
        const callsBefore = invoke.mock.calls.length;

        rerender({ page: 2 });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        // Still no round-trip: the rows were already in hand.
        expect(invoke.mock.calls.length).toBe(callsBefore);
        expect(result.current.data).toHaveLength(40);
      },
    );
  });
});
