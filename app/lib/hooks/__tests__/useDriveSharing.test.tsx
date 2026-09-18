// @vitest-environment jsdom
// The one answer to "is this drive shared, and may I manage it" — read by the
// header mark and by File Details, which is why it lives in one place.
import React, { type ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const listMyDriveMembershipsMock = vi.hoisted(() => vi.fn());
const listOwnedDriveSharingMock = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/tauri/sharedDrives", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/app/lib/tauri/sharedDrives")
  >();
  return {
    ...actual,
    listMyDriveMemberships: () => listMyDriveMembershipsMock(),
    listOwnedDriveSharing: (...a: unknown[]) => listOwnedDriveSharingMock(...a),
  };
});
vi.mock("@/app/lib/featureFlags", () => ({ SHARED_DRIVES_ENABLED: true }));

import { useDriveSharing } from "@/app/lib/hooks/useDriveSharing";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return Wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  listMyDriveMembershipsMock.mockResolvedValue([]);
  listOwnedDriveSharingMock.mockResolvedValue([]);
});

describe("useDriveSharing", () => {
  it("reports a private own drive as not shared and not manageable", async () => {
    const { result } = renderHook(() => useDriveSharing("solo"), { wrapper: wrapper() });
    await waitFor(() => expect(listOwnedDriveSharingMock).toHaveBeenCalled());
    expect(result.current.isShared).toBe(false);
    expect(result.current.canManage).toBe(false);
  });

  it("reports an own drive with members as shared and manageable", async () => {
    listOwnedDriveSharingMock.mockResolvedValue([
      { label: "team", memberCount: 2, liveInviteCount: 0, totalInviteCount: 0 },
    ]);
    const { result } = renderHook(() => useDriveSharing("team"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isShared).toBe(true));
    expect(result.current.canManage).toBe(true);
    expect(result.current.sharing.direction).toBe("by-me");
  });

  // A member drive is shared, but managing it is the owner's business.
  it("reports a member drive as shared but not manageable", async () => {
    listMyDriveMembershipsMock.mockResolvedValue([
      {
        ownerSs58: "5Owner",
        folderHash: "h",
        displayLabel: "team",
        role: "reader",
        createdAt: "",
        syncedLocally: true,
        localLabel: "team",
      },
    ]);
    const { result } = renderHook(() => useDriveSharing("team"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isShared).toBe(true));
    expect(result.current.canManage).toBe(false);
    expect(result.current.sharing.direction).toBe("with-me");
    expect(listOwnedDriveSharingMock).not.toHaveBeenCalled();
  });

  it("asks nothing when no drive is open", () => {
    const { result } = renderHook(() => useDriveSharing(null), { wrapper: wrapper() });
    expect(result.current.isShared).toBe(false);
    expect(listOwnedDriveSharingMock).not.toHaveBeenCalled();
  });
});
