// Row/view routing for the "Shared with me" section.

import { describe, it, expect } from "vitest";

import {
  getMembershipRowAction,
  getSharedWithMeView,
  type SharedWithMeData,
} from "../sharedWithMeState";

const MEMBERSHIP = {
  ownerSs58: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
  folderHash: "0123456789abcdef",
  displayLabel: "team-docs",
  role: "writer",
  createdAt: "2026-08-20T00:00:00Z",
  syncedLocally: false,
  localLabel: null,
};

describe("getSharedWithMeView", () => {
  it("hides every non-rows state — flag off, loading, unavailable, error, empty", () => {
    const states: SharedWithMeData[] = [
      { kind: "idle" },
      { kind: "loading" },
      { kind: "unavailable" },
      { kind: "error" },
      { kind: "ready", memberships: [] },
    ];
    for (const data of states) {
      expect(getSharedWithMeView(true, data)).toBe("hidden");
    }
    // Flag off hides even a populated list.
    expect(getSharedWithMeView(false, { kind: "ready", memberships: [MEMBERSHIP] })).toBe("hidden");
  });

  it("shows rows only when enabled with at least one membership", () => {
    expect(getSharedWithMeView(true, { kind: "ready", memberships: [MEMBERSHIP] })).toBe("rows");
  });
});

describe("getMembershipRowAction", () => {
  it("routes an unsynced membership to Sync locally", () => {
    expect(getMembershipRowAction({ syncedLocally: false, localLabel: null })).toEqual({
      kind: "sync-locally",
    });
  });

  it("routes a synced membership to its local label", () => {
    expect(getMembershipRowAction({ syncedLocally: true, localLabel: "team-docs-2" })).toEqual({
      kind: "synced",
      localLabel: "team-docs-2",
    });
  });

  it("degrades a synced row with no label to Sync locally (idempotent backend repairs)", () => {
    expect(getMembershipRowAction({ syncedLocally: true, localLabel: null })).toEqual({
      kind: "sync-locally",
    });
  });
});
