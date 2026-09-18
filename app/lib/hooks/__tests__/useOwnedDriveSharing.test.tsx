// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const listOwnedDriveSharingMock = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/tauri/sharedDrives", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/app/lib/tauri/sharedDrives")
  >();
  return {
    ...actual,
    listOwnedDriveSharing: (...a: unknown[]) => listOwnedDriveSharingMock(...a),
  };
});

vi.mock("@/app/lib/featureFlags", () => ({ SHARED_DRIVES_ENABLED: true }));

import {
  invalidateOwnedDriveSharing,
  isDriveShared,
  useOwnedDriveSharing,
} from "@/app/lib/hooks/useOwnedDriveSharing";

const shared = {
  label: "team-docs",
  memberCount: 2,
  liveInviteCount: 1,
  totalInviteCount: 3,
};

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function wrapperFor(client: QueryClient) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return Wrapper;
}

beforeEach(() => vi.clearAllMocks());

describe("useOwnedDriveSharing", () => {
  it("maps the IPC's rows by label", async () => {
    listOwnedDriveSharingMock.mockResolvedValue([shared]);

    const { result } = renderHook(() => useOwnedDriveSharing(["team-docs"]), {
      wrapper: wrapperFor(makeClient()),
    });
    await waitFor(() => expect(result.current.size).toBe(1));
    expect(result.current.get("team-docs")).toEqual({
      memberCount: 2,
      liveInviteCount: 1,
      totalInviteCount: 3,
    });
    expect(listOwnedDriveSharingMock).toHaveBeenCalledWith(["team-docs"]);
  });

  // THE regression. The drive page hands the hook a fresh labels array on
  // every render, and it re-renders constantly while anything syncs. The
  // old effect listed that array in its deps, so each render's cleanup
  // cancelled the request in flight while the "already asked" guard stopped
  // a new one — the backend answered, the row never heard. A re-render
  // mid-flight must not lose the answer.
  it("keeps the answer when the page re-renders while the request is in flight", async () => {
    let release: (rows: unknown) => void = () => {};
    listOwnedDriveSharingMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const { result, rerender } = renderHook(
      () => useOwnedDriveSharing(["team-docs"]),
      { wrapper: wrapperFor(makeClient()) },
    );
    await waitFor(() => expect(listOwnedDriveSharingMock).toHaveBeenCalled());

    rerender();
    rerender();

    await act(async () => {
      release([shared]);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.size).toBe(1));
    expect(isDriveShared(result.current.get("team-docs"))).toBe(true);
    // ...and it did not have to ask again to get there.
    expect(listOwnedDriveSharingMock).toHaveBeenCalledTimes(1);
  });

  // The same drives in a different order, or a new array of the same
  // drives, is the same question.
  it("asks once for one set of drives, whatever the array identity or order", async () => {
    listOwnedDriveSharingMock.mockResolvedValue([shared]);
    const client = makeClient();

    const { result, rerender } = renderHook(
      ({ labels }: { labels: string[] }) => useOwnedDriveSharing(labels),
      {
        wrapper: wrapperFor(client),
        initialProps: { labels: ["team-docs", "photos"] },
      },
    );
    await waitFor(() => expect(result.current.size).toBe(1));

    rerender({ labels: ["photos", "team-docs"] });
    rerender({ labels: ["team-docs", "photos"] });
    await waitFor(() => expect(result.current.size).toBe(1));
    expect(listOwnedDriveSharingMock).toHaveBeenCalledTimes(1);
  });

  // Two surfaces read this (the drive page and the settings sync manager);
  // they share the cache rather than each fanning out.
  it("serves a second reader of the same set from the cache", async () => {
    listOwnedDriveSharingMock.mockResolvedValue([shared]);
    const client = makeClient();

    const first = renderHook(() => useOwnedDriveSharing(["team-docs"]), {
      wrapper: wrapperFor(client),
    });
    await waitFor(() => expect(first.result.current.size).toBe(1));

    const second = renderHook(() => useOwnedDriveSharing(["team-docs"]), {
      wrapper: wrapperFor(client),
    });
    await waitFor(() => expect(second.result.current.size).toBe(1));
    expect(listOwnedDriveSharingMock).toHaveBeenCalledTimes(1);
  });

  // Minting, revoking, removing: the row must follow without a reload.
  it("refetches after a mutation invalidates it", async () => {
    listOwnedDriveSharingMock.mockResolvedValueOnce([]);
    const client = makeClient();

    const { result } = renderHook(() => useOwnedDriveSharing(["team-docs"]), {
      wrapper: wrapperFor(client),
    });
    await waitFor(() => expect(listOwnedDriveSharingMock).toHaveBeenCalledTimes(1));
    expect(isDriveShared(result.current.get("team-docs"))).toBe(false);

    listOwnedDriveSharingMock.mockResolvedValueOnce([shared]);
    await act(async () => {
      await invalidateOwnedDriveSharing(client);
    });
    await waitFor(() =>
      expect(isDriveShared(result.current.get("team-docs"))).toBe(true),
    );
  });

  // Knowing nothing is not the same as knowing a drive is private: Rust
  // omits a drive whose listings both failed, and the map says nothing.
  it("leaves a drive the IPC omitted out of the map", async () => {
    listOwnedDriveSharingMock.mockResolvedValue([]);

    const { result } = renderHook(() => useOwnedDriveSharing(["team-docs"]), {
      wrapper: wrapperFor(makeClient()),
    });
    await waitFor(() => expect(listOwnedDriveSharingMock).toHaveBeenCalled());
    expect(result.current.get("team-docs")).toBeUndefined();
    expect(isDriveShared(result.current.get("team-docs"))).toBe(false);
  });

  it("asks for nothing when there are no drives", () => {
    renderHook(() => useOwnedDriveSharing([]), {
      wrapper: wrapperFor(makeClient()),
    });
    expect(listOwnedDriveSharingMock).not.toHaveBeenCalled();
  });
});

describe("isDriveShared", () => {
  it.each([
    ["members only", { memberCount: 1, liveInviteCount: 0, totalInviteCount: 0 }, true],
    ["a live invite", { memberCount: 0, liveInviteCount: 1, totalInviteCount: 1 }, true],
    // The case that was being hidden: shared once, every link since lapsed.
    ["only lapsed links", { memberCount: 0, liveInviteCount: 0, totalInviteCount: 2 }, true],
    ["never shared", { memberCount: 0, liveInviteCount: 0, totalInviteCount: 0 }, false],
  ])("%s", (_l, sharing, expected) => {
    expect(isDriveShared(sharing)).toBe(expected);
  });

  it("treats an unknown drive as not shared", () => {
    expect(isDriveShared(undefined)).toBe(false);
  });
});
