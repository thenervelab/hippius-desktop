// @vitest-environment jsdom
// The memberships behind the "Shared with me" lists read the same query as
// every other surface, so leaving or joining a drive anywhere (which calls
// `refreshSharedWithMe`) updates them. A page holding its own copy kept a
// drive just left from Manage access on screen, still opening it.
import React, { type ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { DriveMembershipInfo } from "@/app/lib/tauri/sharedDrives";

const listMyDriveMembershipsMock = vi.hoisted(() => vi.fn());
const listMyFolderGrantsMock = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/tauri/sharedDrives", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/tauri/sharedDrives")>();
  return {
    ...actual,
    listMyDriveMemberships: () => listMyDriveMembershipsMock(),
    listMyFolderGrants: () => listMyFolderGrantsMock(),
  };
});
vi.mock("@/app/lib/featureFlags", () => ({
  SHARED_DRIVES_ENABLED: true,
  FOLDER_ROLES_ENABLED: true,
}));

import { useDriveMemberships } from "../useDriveMemberships";
import {
  SHARED_DRIVE_MEMBERSHIPS_QUERY_KEY,
  refreshSharedWithMe,
  useMyFolderGrants,
  useSharedDriveMemberships,
} from "@/app/lib/hooks/useSharedDriveRoles";

const OWNER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const membership = (displayLabel: string, folderHash: string): DriveMembershipInfo => ({
  ownerSs58: OWNER,
  folderHash,
  displayLabel,
  role: "manager",
  createdAt: "2026-09-01T00:00:00Z",
  syncedLocally: false,
  localLabel: null,
});
const MARKETING = membership("Marketing", "a1".repeat(8));
const PLANNING = membership("Q4 Planning", "b2".repeat(8));

function setup() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () => ({ page: useDriveMemberships(), badges: useSharedDriveMemberships() }),
    { wrapper },
  );
  return { client, ...hook };
}

beforeEach(() => {
  vi.clearAllMocks();
  listMyFolderGrantsMock.mockResolvedValue([]);
});

describe("useDriveMemberships", () => {
  it("drops a drive this account left elsewhere, from the list and the badges alike", async () => {
    listMyDriveMembershipsMock.mockResolvedValue([MARKETING, PLANNING]);
    const { client, result } = setup();
    await waitFor(() => expect(result.current.page.data).toEqual({ kind: "ready", memberships: [MARKETING, PLANNING] }));
    expect(result.current.badges).toEqual([MARKETING, PLANNING]);

    // Left from Manage access, which invalidates the memberships query: the
    // server no longer lists the drive.
    listMyDriveMembershipsMock.mockResolvedValue([PLANNING]);
    await act(async () => {
      await client.invalidateQueries({ queryKey: [SHARED_DRIVE_MEMBERSHIPS_QUERY_KEY] });
    });
    await waitFor(() => expect(result.current.page.data).toEqual({ kind: "ready", memberships: [PLANNING] }));
    expect(result.current.badges).toEqual([PLANNING]);
  });

  it("refreshSharedWithMe reads both the drives and the folders shared with you again", async () => {
    listMyDriveMembershipsMock.mockResolvedValue([MARKETING]);
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => ({ page: useDriveMemberships(), grants: useMyFolderGrants() }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.page.data.kind).toBe("ready"));
    await waitFor(() => expect(result.current.grants.isSettled).toBe(true));
    expect(listMyDriveMembershipsMock).toHaveBeenCalledTimes(1);
    expect(listMyFolderGrantsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await refreshSharedWithMe(client);
    });
    expect(listMyDriveMembershipsMock).toHaveBeenCalledTimes(2);
    expect(listMyFolderGrantsMock).toHaveBeenCalledTimes(2);
  });

  it("asks once for both readers, not once each", async () => {
    listMyDriveMembershipsMock.mockResolvedValue([MARKETING]);
    const { result } = setup();
    await waitFor(() => expect(result.current.page.data.kind).toBe("ready"));
    expect(listMyDriveMembershipsMock).toHaveBeenCalledTimes(1);
  });

  it("settles a failed fetch as an error, and Try again brings the rows back", async () => {
    listMyDriveMembershipsMock.mockRejectedValue({ kind: "Network", message: "offline" });
    const { result } = setup();
    await waitFor(() => expect(result.current.page.data).toEqual({ kind: "error" }));

    listMyDriveMembershipsMock.mockResolvedValue([MARKETING]);
    await act(async () => {
      await result.current.page.reload();
    });
    expect(result.current.page.data).toEqual({ kind: "ready", memberships: [MARKETING] });
  });

  it("hides quietly on a server with shared drives off", async () => {
    listMyDriveMembershipsMock.mockRejectedValue({
      kind: "NotReady",
      subkind: "SHARED_DRIVES_UNAVAILABLE",
      message: "off",
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.page.data).toEqual({ kind: "unavailable" }));
    expect(result.current.badges).toEqual([]);
  });

  it("can be told the feature went off mid-session, and asks again on reload", async () => {
    listMyDriveMembershipsMock.mockResolvedValue([MARKETING]);
    const { result } = setup();
    await waitFor(() => expect(result.current.page.data.kind).toBe("ready"));
    act(() => result.current.page.markUnavailable());
    expect(result.current.page.data).toEqual({ kind: "unavailable" });
    await act(async () => {
      await result.current.page.reload();
    });
    expect(result.current.page.data).toEqual({ kind: "ready", memberships: [MARKETING] });
  });
});
