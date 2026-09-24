// The panel's words. The web console's panel uses the same ones, so a change
// here is a change there too.

import { describe, it, expect } from "vitest";
import type { AccessPanel, AccessPanelLink } from "@/app/lib/tauri/sharedDrives";
import {
  durationWords,
  endedLinksLine,
  holderFolderTag,
  isOnlyOwner,
  linkCreator,
  linkEndedLabel,
  linkExpiry,
  linkMeta,
  memberMeta,
  panelSubline,
  pendingLeft,
  pendingStage,
  planLabel,
  rolePhrase,
} from "../accessPanelView";

const DAY = 86_400;

const link = (over: Partial<AccessPanelLink> = {}): AccessPanelLink => ({
  inviteId: "l",
  role: "writer",
  mintedBy: "5Sara",
  mintedByName: "Sara Khan",
  mintedByYou: false,
  useCount: 12,
  maxUses: 50,
  singleUse: false,
  usagePercent: 24,
  status: "active",
  expiresAt: "",
  neverExpires: false,
  expiresInSecs: 5 * DAY,
  linkAvailable: true,
  ...over,
});

const empty: AccessPanel = {
  ownerSs58: "5O",
  ownerIsYou: true,
  yourRole: "owner",
  canManage: true,
  members: [],
  folderHolders: [],
  pendingInvites: [],
  links: [],
  inactiveLinks: [],
  linksLocked: false,
  driveMemberCount: 0,
};

describe("header", () => {
  it("calls an owner's drive theirs, with the plan when known", () => {
    const base = { folder: false, ownerIsYou: true, driveName: "Archive", ownerName: "x", yourRole: "owner" };
    expect(panelSubline({ ...base, planName: "Plus plan" })).toBe("Your drive · Plus plan");
    expect(panelSubline({ ...base, planName: null })).toBe("Your drive");
    expect(panelSubline({ ...base, folder: true, planName: "Plus plan" })).toBe("Folder in Archive");
  });

  it("tells anyone else, a Manager included, whose drive it is and what they are", () => {
    const base = { folder: false, ownerIsYou: false, driveName: "Archive", ownerName: "Ahmad Rao", planName: "Plus plan" };
    expect(panelSubline({ ...base, yourRole: "writer" })).toBe("Shared with you by Ahmad Rao · you are an Editor");
    expect(panelSubline({ ...base, yourRole: "manager" })).toBe("Shared with you by Ahmad Rao · you are a Manager");
    expect(panelSubline({ ...base, folder: true, yourRole: "reader" })).toBe(
      "Shared with you by Ahmad Rao · you are a Viewer",
    );
    expect(panelSubline({ ...base, yourRole: null })).toBe("Shared with you by Ahmad Rao");
  });

  it("names a plan once", () => {
    expect(planLabel("Plus")).toBe("Plus plan");
    expect(planLabel("Free plan")).toBe("Free plan");
    expect(planLabel("  ")).toBeNull();
    expect(rolePhrase("manager")).toBe("a Manager");
  });
});

describe("rows", () => {
  it("gives a member their email, else when they joined, and on a folder their whole-drive access", () => {
    const m = { memberSs58: "5A", role: "reader", isYou: false, createdAt: "2026-08-20T12:00:00Z" };
    expect(memberMeta({ ...m, memberEmail: "a@b.c" }, false)).toBe("a@b.c");
    expect(memberMeta(m, false)).toBe("Joined Aug 20, 2026");
    expect(memberMeta({ ...m, createdAt: "bad" }, false)).toBeNull();
    expect(memberMeta(m, true)).toBe("Has the whole drive");
  });

  it("tags a holder with their folder and how many more they hold", () => {
    const h = { memberSs58: "5B", isYou: false, role: "reader", pathPrefix: "Clients/ACME" };
    expect(holderFolderTag({ ...h, folders: ["Clients/ACME"] })).toBe("Clients/ACME");
    expect(holderFolderTag({ ...h, folders: ["Clients/ACME", "Work", "X"] })).toBe("Clients/ACME +2");
  });

  it("reads an invitation's stage and the time it has left", () => {
    expect(pendingStage("sent")).toBe("Invite sent");
    expect(pendingStage("awaiting_seal")).toBe("Needs approval");
    expect(pendingStage("sealed")).toBe("Approved");
    expect(pendingLeft(6 * DAY + 10)).toBe("6 days left");
    expect(pendingLeft(null)).toBeNull();
  });
});

describe("links", () => {
  it("says usage and expiry as the design words them", () => {
    expect(linkMeta(link())).toBe("12 of 50 used · Expires in 5 days");
    expect(linkMeta(link({ neverExpires: true, expiresInSecs: null }))).toBe("12 of 50 used · Never expires");
    expect(linkMeta(link({ singleUse: true, maxUses: 1, useCount: 0, expiresInSecs: 20 * 3600 }))).toBe(
      "Single use, not used yet · Expires in 20 hours",
    );
    expect(linkMeta(link({ singleUse: true, maxUses: 1, useCount: 1, expiresInSecs: null }))).toBe("Used");
    expect(linkExpiry(link({ expiresInSecs: 30 }))).toBe("Expires in less than an hour");
  });

  it("names who made it", () => {
    expect(linkCreator(link({ mintedByYou: true }))).toBe("You");
    expect(linkCreator(link())).toBe("Sara Khan");
    expect(linkCreator(link({ mintedBy: " ", mintedByName: undefined }))).toBeNull();
  });

  it("says why an ended link stopped, and folds them into one line", () => {
    expect(linkEndedLabel("revoked")).toBe("Revoked");
    expect(linkEndedLabel("expired")).toBe("Expired");
    expect(linkEndedLabel("used_up")).toBe("All uses taken");
    expect(endedLinksLine(1)).toBe("1 expired or revoked link");
    expect(endedLinksLine(3)).toBe("3 expired or revoked links");
  });

  it("counts time down in whole units", () => {
    expect(durationWords(2 * DAY)).toBe("2 days");
    expect(durationWords(DAY + 5)).toBe("1 day");
    expect(durationWords(3600)).toBe("1 hour");
  });
});

describe("empty", () => {
  it("is empty only for an owner with nobody and nothing on the way", () => {
    expect(isOnlyOwner(empty)).toBe(true);
    expect(isOnlyOwner({ ...empty, ownerIsYou: false })).toBe(false);
    expect(isOnlyOwner({ ...empty, links: [link()] })).toBe(false);
    // An ended link is not access.
    expect(isOnlyOwner({ ...empty, inactiveLinks: [link({ status: "revoked" })] })).toBe(true);
  });
});
