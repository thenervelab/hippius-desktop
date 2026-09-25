// Row/view routing for the "Shared with me" section.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  folderGrantRowView,
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

// The row printed the wire word raw, so a drive shared with you announced
// itself as "writer". The wire vocabulary is reader/writer/manager; every
// surface a person reads says Viewer/Editor/Manager.
describe("the Shared with me row's role", () => {
  it("never shows a wire word", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../SharedWithMeSection.tsx"),
      "utf8",
    );
    // The row now renders the shared role CHIP, which does the labelling
    // itself. What must never appear is the raw wire word.
    expect(source).toContain("<DriveRoleChip role={role} />");
    expect(source).toContain("parseDriveRole(membership.role)");
    expect(source).not.toMatch(/·\s*\{membership\.role\}/);
  });
});

describe("shared folders (folder roles)", () => {
  it("shows the section for folders alone, whatever the drive listing did", () => {
    expect(getSharedWithMeView(true, { kind: "loading" }, 1)).toBe("rows");
    expect(getSharedWithMeView(true, { kind: "ready", memberships: [] }, 2)).toBe("rows");
    expect(getSharedWithMeView(true, { kind: "ready", memberships: [] }, 0)).toBe("hidden");
    expect(getSharedWithMeView(false, { kind: "ready", memberships: [] }, 3)).toBe("hidden");
  });

  it("names the folder by its own name and keeps the drive and path", () => {
    const view = folderGrantRowView({
      ownerSs58: "5Owner",
      folderHash: "abc",
      pathPrefix: "/Clients/ACME/",
      displayLabel: "Team",
    });
    expect(view).toEqual({
      key: "5Owner:abc:Clients/ACME",
      folderName: "ACME",
      driveName: "Team",
      path: "Clients/ACME",
    });
  });
});
