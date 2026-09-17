// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const listDriveMembersMock = vi.hoisted(() => vi.fn());
const listDriveInvitesMock = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/tauri/sharedDrives", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/app/lib/tauri/sharedDrives")
  >();
  return {
    ...actual,
    listDriveMembers: (...a: unknown[]) => listDriveMembersMock(...a),
    listDriveInvites: (...a: unknown[]) => listDriveInvitesMock(...a),
  };
});

vi.mock("@/app/lib/featureFlags", () => ({ SHARED_DRIVES_ENABLED: true }));

import {
  isDriveShared,
  useOwnedDriveSharing,
} from "@/app/lib/hooks/useOwnedDriveSharing";

const member = { memberSs58: "5abc", role: "writer", createdAt: "" };
const liveInvite = {
  inviteId: "i1",
  role: "writer",
  expiresAt: "2126-01-01T00:00:00Z",
  maxUses: 50,
  useCount: 0,
  revoked: false,
  valid: true,
  createdAt: "",
};

beforeEach(() => vi.clearAllMocks());

describe("useOwnedDriveSharing", () => {
  it("reports members and live invites together", async () => {
    listDriveMembersMock.mockResolvedValue([member]);
    listDriveInvitesMock.mockResolvedValue([liveInvite]);

    const { result } = renderHook(() => useOwnedDriveSharing(["team-docs"]));
    await waitFor(() => expect(result.current.size).toBe(1));
    expect(result.current.get("team-docs")).toEqual({
      memberCount: 1,
      liveInviteCount: 1,
    });
  });

  // The regression: the two listings were fetched with `Promise.all`, so an
  // unavailable `/invites` route -- newer than `/members` -- discarded the
  // member count too and hid the badge on a drive people had demonstrably
  // joined.
  it("keeps the member count when the invite listing fails", async () => {
    listDriveMembersMock.mockResolvedValue([member, member]);
    listDriveInvitesMock.mockRejectedValue(new Error("404"));

    const { result } = renderHook(() => useOwnedDriveSharing(["team-docs"]));
    await waitFor(() => expect(result.current.size).toBe(1));

    const sharing = result.current.get("team-docs");
    expect(sharing?.memberCount).toBe(2);
    expect(sharing?.liveInviteCount).toBe(0);
    expect(isDriveShared(sharing)).toBe(true);
  });

  it("keeps live invites when the member listing fails", async () => {
    listDriveMembersMock.mockRejectedValue(new Error("boom"));
    listDriveInvitesMock.mockResolvedValue([liveInvite]);

    const { result } = renderHook(() => useOwnedDriveSharing(["team-docs"]));
    await waitFor(() => expect(result.current.size).toBe(1));
    expect(isDriveShared(result.current.get("team-docs"))).toBe(true);
  });

  // Knowing nothing is not the same as knowing a drive is private.
  it("omits a drive when both listings fail", async () => {
    listDriveMembersMock.mockRejectedValue(new Error("a"));
    listDriveInvitesMock.mockRejectedValue(new Error("b"));

    const { result } = renderHook(() => useOwnedDriveSharing(["team-docs"]));
    await waitFor(() => expect(listDriveInvitesMock).toHaveBeenCalled());
    expect(result.current.get("team-docs")).toBeUndefined();
    expect(isDriveShared(result.current.get("team-docs"))).toBe(false);
  });

  it("counts a revoked or expired invite as not live", async () => {
    listDriveMembersMock.mockResolvedValue([]);
    listDriveInvitesMock.mockResolvedValue([
      { ...liveInvite, revoked: true, valid: false },
      { ...liveInvite, inviteId: "i2", valid: false },
    ]);

    const { result } = renderHook(() => useOwnedDriveSharing(["team-docs"]));
    await waitFor(() => expect(result.current.size).toBe(1));
    expect(isDriveShared(result.current.get("team-docs"))).toBe(false);
  });

  it("asks for nothing when there are no drives", async () => {
    renderHook(() => useOwnedDriveSharing([]));
    expect(listDriveMembersMock).not.toHaveBeenCalled();
  });
});

describe("isDriveShared", () => {
  it.each([
    ["members only", { memberCount: 1, liveInviteCount: 0 }, true],
    ["a live invite only", { memberCount: 0, liveInviteCount: 1 }, true],
    ["neither", { memberCount: 0, liveInviteCount: 0 }, false],
  ])("%s", (_l, sharing, expected) => {
    expect(isDriveShared(sharing)).toBe(expected);
  });

  it("treats an unknown drive as not shared", () => {
    expect(isDriveShared(undefined)).toBe(false);
  });
});
