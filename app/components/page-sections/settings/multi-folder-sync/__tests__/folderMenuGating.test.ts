// Own-vs-member gating for the folder row menus. The resolver is the ONLY
// place the menus decide which gated items to show, so these tests are the
// contract for both the 3-dot menu and the right-click menu at once.

import { describe, it, expect } from "vitest";

import {
  isMemberDrive,
  resolveFolderMenuPlan,
} from "../folderMenuGating";

const OWNER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

describe("isMemberDrive", () => {
  it("is true only for a row carrying a non-empty ownerSs58", () => {
    expect(isMemberDrive({ ownerSs58: OWNER })).toBe(true);
    expect(isMemberDrive({})).toBe(false);
    expect(isMemberDrive({ ownerSs58: undefined })).toBe(false);
    expect(isMemberDrive({ ownerSs58: "" })).toBe(false);
  });
});

describe("resolveFolderMenuPlan", () => {
  it("own drive with the flag on: Share drive plus the full own-drive menu", () => {
    const plan = resolveFolderMenuPlan({}, { sharedDrivesEnabled: true });
    expect(plan).toEqual({
      showShareDrive: true,
      showExclusions: true,
      showDeleteFromServer: true,
      removeItemTitle: "Remove from Sync",
      removeIsLeave: false,
    });
  });

  it("member drive with the flag on: no owner-only items, remove becomes Leave", () => {
    const plan = resolveFolderMenuPlan(
      { ownerSs58: OWNER },
      { sharedDrivesEnabled: true },
    );
    expect(plan).toEqual({
      showShareDrive: false,
      showExclusions: false,
      showDeleteFromServer: false,
      removeItemTitle: "Leave shared drive",
      removeIsLeave: true,
    });
  });

  it("flag off, own drive: plain own-drive menu, only Share drive is withheld", () => {
    const plan = resolveFolderMenuPlan({}, { sharedDrivesEnabled: false });
    expect(plan).toEqual({
      showShareDrive: false,
      showExclusions: true,
      showDeleteFromServer: true,
      removeItemTitle: "Remove from Sync",
      removeIsLeave: false,
    });
  });

  it("flag off, member drive: the protective gating survives a flag rollback", () => {
    // Member-ness is data on the row, not feature state: a member row from
    // an earlier flag-on build must never regain Delete from Server (wrong
    // identity server-side) or a plain Remove that strands the membership.
    const plan = resolveFolderMenuPlan(
      { ownerSs58: OWNER },
      { sharedDrivesEnabled: false },
    );
    expect(plan).toEqual({
      showShareDrive: false,
      showExclusions: false,
      showDeleteFromServer: false,
      removeItemTitle: "Leave shared drive",
      removeIsLeave: true,
    });
  });
});
