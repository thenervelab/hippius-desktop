// The dev-only preview fixture: never on unless the build allows it and the
// key is set, clamped to 0..30, and shaped like a real listing (some people
// without a name, about a third pending, refusals on some rows).

import { describe, it, expect, vi } from "vitest";
import {
  SHARE_FIXTURE_AVAILABLE,
  fixtureShareAccess,
  fixtureShareAccessApi,
  shareFixtureSize,
} from "../shareAccessApi";

describe("shareFixtureSize", () => {
  it("is off on a build that does not allow it, whatever the key says", () => {
    expect(shareFixtureSize(false, () => "12")).toBeNull();
  });

  it("is off in the test build, which stands in for production", () => {
    expect(SHARE_FIXTURE_AVAILABLE).toBe(false);
  });

  it("reads and clamps the key when allowed", () => {
    expect(shareFixtureSize(true, () => null)).toBeNull();
    expect(shareFixtureSize(true, () => "")).toBeNull();
    expect(shareFixtureSize(true, () => "abc")).toBeNull();
    expect(shareFixtureSize(true, () => "0")).toBe(0);
    expect(shareFixtureSize(true, () => "12")).toBe(12);
    expect(shareFixtureSize(true, () => "99")).toBe(30);
    expect(shareFixtureSize(true, () => "-4")).toBe(0);
  });

  it("treats unreadable storage as off", () => {
    expect(
      shareFixtureSize(true, () => {
        throw new Error("blocked");
      }),
    ).toBeNull();
  });
});

describe("fixtureShareAccess", () => {
  it("has nobody but the owner at zero", () => {
    const a = fixtureShareAccess(0, false);
    expect(a.members).toHaveLength(0);
    expect(a.pendingInvites).toHaveLength(0);
    expect(a.ownerIsYou).toBe(true);
  });

  it("splits people into members and pending invites, some without names", () => {
    const a = fixtureShareAccess(30, false);
    expect(a.members.length + a.pendingInvites.length).toBe(30);
    expect(a.pendingInvites).toHaveLength(10);
    expect(a.members.some((m) => !m.memberName)).toBe(true);
    expect(a.pendingInvites.some((i) => i.emailStatus === "awaiting_seal")).toBe(true);
  });

  it("lists folder holders instead of members for a folder", () => {
    const a = fixtureShareAccess(9, true);
    expect(a.members).toHaveLength(0);
    expect(a.folderHolders).toHaveLength(6);
  });
});

describe("fixtureShareAccessApi", () => {
  it("applies a change after a delay, or refuses it for some rows", async () => {
    vi.useFakeTimers();
    try {
      const api = fixtureShareAccessApi(12, false);
      const listed = api.list("x", null);
      await vi.advanceTimersByTimeAsync(2000);
      const members = (await listed).members;
      const outcomes = await Promise.all(
        members.map(async (m) => {
          const p = api.changeRole("x", m.memberSs58, "manager").then(
            () => "ok",
            () => "refused",
          );
          await vi.advanceTimersByTimeAsync(2000);
          return p;
        }),
      );
      expect(outcomes).toContain("ok");
      expect(outcomes).toContain("refused");
    } finally {
      vi.useRealTimers();
    }
  });
});
