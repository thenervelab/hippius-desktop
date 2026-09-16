// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  REMOTE_SOURCE_PREFIX,
  useNestedFolderListing,
} from "../use-nested-folder-listing";

const entry = (name: string, isFolder = false) => ({
  name,
  is_folder: isFolder,
  size: 1,
  modified: 1700000000,
  sync_status: "synced",
  arion_hash: `h-${name}`,
});

/** A local level: one folder and one file, whatever the arguments. */
const localServer = (cmd: string) =>
  cmd === "list_sync_folder_grouped"
    ? Promise.resolve({ folders: [entry("photos", true)], files: [entry("a.txt")] })
    : Promise.resolve(null);

const localOpts = {
  accountId: "acct",
  syncPath: "/Users/someone/Drive",
  subfolder: null,
  label: "Drive",
  enabled: true,
  remote: false,
};

const remoteOpts = {
  accountId: "acct",
  syncPath: null,
  subfolder: null,
  label: "drive",
  enabled: true,
  remote: true,
};

/**
 * The row shape the table renders, which is the hook's real output.
 *
 * `source` is the field every download, rename and reveal gate keys on, and
 * it is built differently in each of four combinations (local/remote by
 * file/folder). The paging tests next door drive the request side; these
 * drive the mapping side, which is what a nested row is actually made of.
 */
describe("useNestedFolderListing row mapping", () => {
  beforeEach(() => invoke.mockReset());

  it("builds a local row's source from the sync path", async () => {
    invoke.mockImplementation(localServer as never);
    const { result } = renderHook(() => useNestedFolderListing(localOpts));

    await waitFor(() => expect(result.current.data).toHaveLength(2));
    const byName = Object.fromEntries(
      result.current.data.map((f) => [f.name, f]),
    );
    expect(byName["a.txt"].source).toBe("/Users/someone/Drive/a.txt");
    expect(byName["photos"].source).toBe("/Users/someone/Drive/photos");
  });

  it("puts a nested local file under its subfolder, in both the path and the id", async () => {
    invoke.mockImplementation(localServer as never);
    const { result } = renderHook(() =>
      useNestedFolderListing({ ...localOpts, subfolder: "trip/2024" }),
    );

    await waitFor(() => expect(result.current.data).toHaveLength(2));
    const file = result.current.data.find((f) => f.name === "a.txt");
    expect(file?.source).toBe("/Users/someone/Drive/trip/2024/a.txt");
    // A file's id is drive-relative; a folder's is not prefixed, because the
    // folder-URL builders compose its path themselves.
    expect(file?.actualFileName).toBe("trip/2024/a.txt");
    const folder = result.current.data.find((f) => f.name === "photos");
    expect(folder?.actualFileName).toBe("photos");
  });

  it("gives a remote folder the sentinel source and a remote file none", async () => {
    invoke.mockImplementation(((cmd: string) =>
      cmd === "list_remote_folder_grouped"
        ? Promise.resolve({
            folders: [entry("photos", true)],
            files: [entry("a.txt")],
            hasMore: false,
            totalCount: 2,
          })
        : Promise.resolve(null)) as never);

    const { result } = renderHook(() => useNestedFolderListing(remoteOpts));

    await waitFor(() => expect(result.current.data).toHaveLength(2));
    const byName = Object.fromEntries(
      result.current.data.map((f) => [f.name, f]),
    );
    // The sentinel is what threads a recognizable `folderSource` into nested
    // navigation for a drive with no local path.
    expect(byName["photos"].source).toBe(`${REMOTE_SOURCE_PREFIX}drive`);
    // Never a "null/…"-shaped string for a future consumer to pick up.
    expect(byName["a.txt"].source).toBeUndefined();
  });
});

describe("useNestedFolderListing request gating", () => {
  beforeEach(() => invoke.mockReset());

  it("asks for nothing while disabled", async () => {
    invoke.mockImplementation(localServer as never);
    renderHook(() => useNestedFolderListing({ ...localOpts, enabled: false }));

    await new Promise((r) => setTimeout(r, 0));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("asks for nothing when a remote drive has no label to name", async () => {
    invoke.mockImplementation(localServer as never);
    // Remote levels are keyed by label; without one there is no folder to
    // request, and a half-built key must not become a request.
    renderHook(() => useNestedFolderListing({ ...remoteOpts, label: null }));

    await new Promise((r) => setTimeout(r, 0));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("asks for nothing when a local drive has no sync path", async () => {
    invoke.mockImplementation(localServer as never);
    renderHook(() => useNestedFolderListing({ ...localOpts, syncPath: null }));

    await new Promise((r) => setTimeout(r, 0));
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("useNestedFolderListing server-side sort", () => {
  beforeEach(() => invoke.mockReset());

  const page = () =>
    Promise.resolve({ folders: [], files: [entry("a")], hasMore: false, totalCount: 1 });

  const argsOf = (call: number) =>
    (invoke.mock.calls[call]?.[1] ?? {}) as Record<string, unknown>;

  it("sends no sort when none is asked for, keeping the server's own order", async () => {
    invoke.mockImplementation((() => page()) as never);
    renderHook(() =>
      useNestedFolderListing({ ...remoteOpts, page: 1, pageSize: 15 }),
    );

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(argsOf(0).sortBy).toBeNull();
    expect(argsOf(0).sortOrder).toBeNull();
  });

  it("passes the sort through so the server orders the whole folder", async () => {
    invoke.mockImplementation((() => page()) as never);
    renderHook(() =>
      useNestedFolderListing({
        ...remoteOpts,
        page: 1,
        pageSize: 15,
        sortBy: "file_name",
        sortDir: "desc",
      }),
    );

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(argsOf(0).sortBy).toBe("file_name");
    expect(argsOf(0).sortOrder).toBe("desc");
  });

  it("refetches when the sort changes, because the order is the request", async () => {
    invoke.mockImplementation((() => page()) as never);
    const { rerender } = renderHook(
      ({ sortDir }: { sortDir: "asc" | "desc" }) =>
        useNestedFolderListing({
          ...remoteOpts,
          page: 1,
          pageSize: 15,
          sortBy: "file_name",
          sortDir,
        }),
      { initialProps: { sortDir: "asc" } as { sortDir: "asc" | "desc" } },
    );

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    rerender({ sortDir: "desc" });
    // A new direction re-orders the whole folder, so the page in hand is
    // no longer an answer to the question being asked.
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(argsOf(1).sortOrder).toBe("desc");
  });
});
