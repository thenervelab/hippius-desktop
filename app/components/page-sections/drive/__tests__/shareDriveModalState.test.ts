// Pure view routing for ShareDriveModal (the sidebarSearchState convention).

import { describe, it, expect } from "vitest";

import {
  DEFAULT_INVITE_TTL_SECS,
  formatJoinedDate,
  getMembersView,
  INVITE_TTL_OPTIONS,
  NEVER_EXPIRES_SECS,
  clampInviteTtl,
  inviteTtlOptionsFor,
  EMAIL_INVITE_ROLES,
  EMAIL_INVITE_TTL_OPTIONS,
  clampEmailInviteTtl,
  groupFolderGrantsByHolder,
} from "../shareDriveModalState";
import { MANAGER_INVITE_MAX_SECONDS } from "@/app/lib/shared-drives/roles";

describe("getMembersView", () => {
  it("maps idle and loading to the skeleton", () => {
    expect(getMembersView({ kind: "idle" })).toBe("loading");
    expect(getMembersView({ kind: "loading" })).toBe("loading");
  });

  it("splits ready into empty vs rows", () => {
    expect(getMembersView({ kind: "ready", members: [], folderGrants: [] })).toBe(
      "empty",
    );
    expect(
      getMembersView({
        kind: "ready",
        members: [{ memberSs58: "5X", role: "writer", createdAt: "2026-08-20T00:00:00Z" }],
        folderGrants: [],
      }),
    ).toBe("rows");
    expect(
      getMembersView({
        kind: "ready",
        members: [],
        folderGrants: [
          {
            memberSs58: "5Y",
            pathPrefix: "Work",
            role: "reader",
            createdAt: "2026-09-23T00:00:00Z",
          },
        ],
      }),
    ).toBe("rows");
  });

  it("keeps unavailable distinct from error — one degrades quietly, one surfaces", () => {
    expect(getMembersView({ kind: "unavailable" })).toBe("unavailable");
    expect(getMembersView({ kind: "error", message: "boom" })).toBe("error");
  });
});

describe("INVITE_TTL_OPTIONS", () => {
  it("includes the display default (7 days) and only positive lifetimes", () => {
    expect(INVITE_TTL_OPTIONS.every((o) => o.secs > 0)).toBe(true);
    expect(INVITE_TTL_OPTIONS.some((o) => o.secs === DEFAULT_INVITE_TTL_SECS)).toBe(true);
  });

  it("offers a never-expiring invite pinned to the server's 100-year cap", () => {
    // The server accepts up to exactly 100 years (MAX_EXPIRES_SECS) and
    // "never" is represented as that cap value — drifting from it turns the
    // preset into a 400 at mint time.
    expect(NEVER_EXPIRES_SECS).toBe(100 * 365 * 24 * 60 * 60);
    expect(INVITE_TTL_OPTIONS.some((o) => o.secs === NEVER_EXPIRES_SECS)).toBe(true);
  });
});

describe("inviteTtlOptionsFor / clampInviteTtl", () => {
  it("restricts a manager invite to the 24-hour preset", () => {
    const secs = inviteTtlOptionsFor("manager").map((o) => o.secs);
    expect(secs).toEqual([MANAGER_INVITE_MAX_SECONDS]);
  });

  it("leaves reader and writer presets uncapped", () => {
    expect(inviteTtlOptionsFor("writer")).toEqual(INVITE_TTL_OPTIONS);
    expect(inviteTtlOptionsFor("reader")).toEqual(INVITE_TTL_OPTIONS);
  });

  it("snaps an over-wide selection when the role becomes manager", () => {
    expect(clampInviteTtl("manager", DEFAULT_INVITE_TTL_SECS)).toBe(
      MANAGER_INVITE_MAX_SECONDS,
    );
    expect(clampInviteTtl("manager", NEVER_EXPIRES_SECS)).toBe(
      MANAGER_INVITE_MAX_SECONDS,
    );
    expect(clampInviteTtl("writer", NEVER_EXPIRES_SECS)).toBe(NEVER_EXPIRES_SECS);
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

describe("emailed invitation choices", () => {
  it("never offers a lifetime the server refuses for a mailed invite", () => {
    expect(EMAIL_INVITE_TTL_OPTIONS.some((o) => o.secs === NEVER_EXPIRES_SECS)).toBe(false);
    for (const o of EMAIL_INVITE_TTL_OPTIONS) {
      expect(o.secs).toBeGreaterThanOrEqual(60 * 60);
      expect(o.secs).toBeLessThanOrEqual(30 * 24 * 60 * 60);
    }
  });

  it("offers Viewer and Editor only", () => {
    expect([...EMAIL_INVITE_ROLES]).toEqual(["reader", "writer"]);
  });

  it("snaps a link-only lifetime back to the default", () => {
    expect(clampEmailInviteTtl(NEVER_EXPIRES_SECS)).toBe(DEFAULT_INVITE_TTL_SECS);
    expect(clampEmailInviteTtl(24 * 60 * 60)).toBe(24 * 60 * 60);
  });
});

describe("groupFolderGrantsByHolder", () => {
  it("makes one row per person, keyed by ss58, with every folder", () => {
    const rows = groupFolderGrantsByHolder([
      { memberSs58: "5A", pathPrefix: "b", role: "writer", createdAt: "2026-02-01" },
      { memberSs58: "5B", pathPrefix: "x", role: "reader", createdAt: "2026-01-01", memberName: "Bo" },
      { memberSs58: "5A", pathPrefix: "a", role: "writer", createdAt: "2026-01-15", memberName: "Ada" },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      memberSs58: "5A",
      memberName: "Ada",
      folders: ["a", "b"],
      role: "writer",
      createdAt: "2026-01-15",
    });
    expect(rows[1]).toMatchObject({ memberSs58: "5B", memberName: "Bo", folders: ["x"] });
  });
});
