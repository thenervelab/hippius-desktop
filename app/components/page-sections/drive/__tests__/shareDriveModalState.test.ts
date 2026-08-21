// Pure view routing for ShareDriveModal (the sidebarSearchState convention).

import { describe, it, expect } from "vitest";

import {
  DEFAULT_INVITE_TTL_SECS,
  formatJoinedDate,
  getMembersView,
  INVITE_TTL_OPTIONS,
} from "../shareDriveModalState";

describe("getMembersView", () => {
  it("maps idle and loading to the skeleton", () => {
    expect(getMembersView({ kind: "idle" })).toBe("loading");
    expect(getMembersView({ kind: "loading" })).toBe("loading");
  });

  it("splits ready into empty vs rows", () => {
    expect(getMembersView({ kind: "ready", members: [] })).toBe("empty");
    expect(
      getMembersView({
        kind: "ready",
        members: [{ memberSs58: "5X", role: "writer", createdAt: "2026-08-20T00:00:00Z" }],
      }),
    ).toBe("rows");
  });

  it("keeps unavailable distinct from error — one degrades quietly, one surfaces", () => {
    expect(getMembersView({ kind: "unavailable" })).toBe("unavailable");
    expect(getMembersView({ kind: "error", message: "boom" })).toBe("error");
  });
});

describe("INVITE_TTL_OPTIONS", () => {
  it("offers no never-expiring invite and includes the display default (7 days)", () => {
    expect(INVITE_TTL_OPTIONS.every((o) => o.secs > 0)).toBe(true);
    expect(INVITE_TTL_OPTIONS.some((o) => o.secs === DEFAULT_INVITE_TTL_SECS)).toBe(true);
  });
});

describe("formatJoinedDate", () => {
  it("renders a fixed en-US short date", () => {
    expect(formatJoinedDate("2026-08-20T12:00:00Z")).toMatch(/^Aug (19|20|21), 2026$/);
  });

  it("returns null for an unparseable timestamp", () => {
    expect(formatJoinedDate("not-a-date")).toBeNull();
  });
});
