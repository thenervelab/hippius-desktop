// The dev-only preview fixture: never on unless the build allows it and the
// key is set, clamped to 0..30, and shaped like a real listing (some people
// without a name, about a third pending, refusals on some rows).

import { describe, it, expect, vi } from "vitest";
import {
  SHARE_FIXTURE_AVAILABLE,
  fixtureShareAccess,
  fixtureShareAccessApi,
  shareFixtureLocked,
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

describe("the preview fixture's roles", () => {
  // The fixture stands in for Rust, which never sends `manager` to the UI.
  it("never draws a Manager, in the dialog or the panel", async () => {
    vi.useFakeTimers();
    try {
      for (const folder of [false, true]) {
        const api = fixtureShareAccessApi(30, folder);
        const listedAccess = api.list("x", folder ? "Work" : null);
        const listedPanel = api.listPanel("x", folder ? "Work" : null);
        await vi.advanceTimersByTimeAsync(2000);
        const text = JSON.stringify([await listedAccess, await listedPanel]);
        expect(text).not.toMatch(/manager/i);
      }
    } finally {
      vi.useRealTimers();
    }
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
          const p = api.changeRole("x", m.memberSs58, "writer").then(
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

describe("the panel fixture", () => {
  it("lists people, holders, pending invites and links for a drive", async () => {
    vi.useFakeTimers();
    try {
      const api = fixtureShareAccessApi(24, false);
      const listed = api.listPanel("x", null);
      await vi.advanceTimersByTimeAsync(2000);
      const panel = await listed;
      expect(panel.canManage).toBe(true);
      expect(panel.members.length).toBeGreaterThan(0);
      expect(panel.folderHolders.length).toBe(6);
      expect(panel.pendingInvites.every((i) => typeof i.expiresInSecs === "number")).toBe(true);
      expect(panel.links.length).toBe(3);
      expect(panel.inactiveLinks.length).toBe(3);
      expect(panel.linksLocked).toBe(false);
      expect(panel.links.every((l) => l.inviteUrl)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("can draw the links locked", async () => {
    vi.useFakeTimers();
    try {
      const listed = fixtureShareAccessApi(12, false, { linksLocked: true }).listPanel("x", null);
      await vi.advanceTimersByTimeAsync(2000);
      const panel = await listed;
      expect(panel.linksLocked).toBe(true);
      expect(panel.links.some((l) => l.inviteUrl)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("has nothing but the owner at zero", async () => {
    vi.useFakeTimers();
    try {
      const listed = fixtureShareAccessApi(0, true).listPanel("x", "fixture");
      await vi.advanceTimersByTimeAsync(2000);
      const panel = await listed;
      expect(panel.members).toHaveLength(0);
      expect(panel.folderHolders).toHaveLength(0);
      expect(panel.links).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the locked switch only where the fixture is allowed", () => {
    expect(shareFixtureLocked(false, () => "12 locked")).toBe(false);
    expect(shareFixtureLocked(true, () => "12 locked")).toBe(true);
    expect(shareFixtureLocked(true, () => "12")).toBe(false);
  });
});
