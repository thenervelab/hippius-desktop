// The panel's words. The web console's panel uses the same ones, so a change
// here is a change there too.

import { describe, it, expect } from "vitest";
import type { AccessPanel, AccessPanelHolder, AccessPanelLink, AccessPanelMember } from "@/app/lib/tauri/sharedDrives";
import {
  ENDED_LINKS_PREVIEW,
  PANEL_PREVIEW,
  SEARCH_PLACEHOLDER,
  capRows,
  linkMatches,
  noMatchLine,
  panelPeople,
  pendingMatches,
  personInFilter,
  personKey,
  personMatches,
  showAllLabel,
  type PanelPerson,
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
  pendingStageHint,
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

  it("tells anyone else, a former Manager included, whose drive it is and what they are", () => {
    const base = { folder: false, ownerIsYou: false, driveName: "Archive", ownerName: "Ahmad Rao", planName: "Plus plan" };
    expect(panelSubline({ ...base, yourRole: "writer" })).toBe("Shared with you by Ahmad Rao · you are an Editor");
    expect(panelSubline({ ...base, yourRole: "manager" })).toBe("Shared with you by Ahmad Rao · you are an Editor");
    expect(panelSubline({ ...base, folder: true, yourRole: "reader" })).toBe(
      "Shared with you by Ahmad Rao · you are a Viewer",
    );
    expect(panelSubline({ ...base, yourRole: null })).toBe("Shared with you by Ahmad Rao");
  });

  it("names a plan once", () => {
    expect(planLabel("Plus")).toBe("Plus plan");
    expect(planLabel("Free plan")).toBe("Free plan");
    expect(planLabel("  ")).toBeNull();
    expect(rolePhrase("manager")).toBe("an Editor");
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
    expect(pendingStage("awaiting_seal")).toBe("Opened");
    expect(pendingStageHint("awaiting_seal")).toBe("They join while the app is open. Approve if they are still waiting.");
    expect(pendingStageHint("sent")).toBeUndefined();
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

  it("hands the row the whole address to shorten, never a pre-shortened one", () => {
    const ss58 = "5CV9U636UM4LJqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqLjc3M";
    expect(linkCreator(link({ mintedBy: ss58, mintedByName: undefined }))).toBe(ss58);
    expect(linkCreator(link({ mintedBy: ss58, mintedByName: "  " }))).toBe(ss58);
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

describe("capRows", () => {
  const rows = Array.from({ length: 30 }, (_, i) => i);

  it("draws six people, three invitations and ten links in the main view", () => {
    expect(PANEL_PREVIEW).toEqual({ people: 6, pending: 3, links: 10 });
    expect(ENDED_LINKS_PREVIEW).toBe(6);
    expect(capRows(rows.slice(0, 10), false, PANEL_PREVIEW.links)).toEqual({ shown: rows.slice(0, 10), hidden: 0 });
    expect(capRows(rows.slice(0, 11), false, PANEL_PREVIEW.links)).toEqual({ shown: rows.slice(0, 10), hidden: 1 });
    expect(capRows(rows.slice(0, 6), false, PANEL_PREVIEW.people)).toEqual({ shown: rows.slice(0, 6), hidden: 0 });
    expect(capRows(rows, false, PANEL_PREVIEW.people)).toEqual({ shown: rows.slice(0, 6), hidden: 24 });
    expect(capRows(rows, false, PANEL_PREVIEW.pending)).toEqual({ shown: rows.slice(0, 3), hidden: 27 });
  });

  it("draws everything when expanded, and takes another cap", () => {
    expect(capRows(rows, true, PANEL_PREVIEW.links)).toEqual({ shown: rows, hidden: 0 });
    expect(capRows(rows, false, 0)).toEqual({ shown: [], hidden: 30 });
  });
});

describe("the People group's order", () => {
  const member = (ss58: string, isYou = false, extra: Partial<AccessPanelMember> = {}): AccessPanelMember => ({
    memberSs58: ss58,
    role: "reader",
    isYou,
    createdAt: "t",
    ...extra,
  });
  const holder = (ss58: string, isYou = false): AccessPanelHolder => ({
    memberSs58: ss58,
    isYou,
    role: "writer",
    pathPrefix: "Work",
    folders: ["Work"],
  });

  it("is the owner, you, then members as Rust sent them, then folder holders", () => {
    const panel = { ...empty, members: [member("5New"), member("5Old")], folderHolders: [holder("5Bo")] };
    expect(panelPeople(panel, "Olive").map(personKey)).toEqual(["owner", "5New", "5Old", "holder:5Bo"]);
    expect(panelPeople(panel, "Olive")[0]).toMatchObject({ kind: "owner", name: "Olive" });
  });

  it("puts you right after the owner, whether you are a member or hold a folder", () => {
    const asMember = { ...empty, members: [member("5New"), member("5Me", true)] };
    expect(panelPeople(asMember).map(personKey)).toEqual(["owner", "5Me", "5New"]);
    const asHolder = { ...empty, members: [member("5New")], folderHolders: [holder("5Me", true)] };
    expect(panelPeople(asHolder).map(personKey)).toEqual(["owner", "holder:5Me", "5New"]);
  });
});

describe("search and filters", () => {
  const sara: PanelPerson = {
    kind: "member",
    member: { memberSs58: "5SaraAddr", memberName: "Sara Khan", memberEmail: "sara@acme.io", role: "writer", isYou: false, createdAt: "t" },
  };
  const bo: PanelPerson = {
    kind: "holder",
    holder: { memberSs58: "5BoAddr", memberName: "Bo", isYou: false, role: "reader", pathPrefix: "Work", folders: ["Work"] },
  };
  const owner: PanelPerson = { kind: "owner", ss58: "5OwnerAddr", isYou: true, name: "Olive" };

  it("finds a person by name, email or address, ignoring case and spaces around", () => {
    expect(personMatches(sara, "  SARA ")).toBe(true);
    expect(personMatches(sara, "acme.io")).toBe(true);
    expect(personMatches(sara, "5saraaddr")).toBe(true);
    expect(personMatches(sara, "bo")).toBe(false);
    expect(personMatches(owner, "olive")).toBe(true);
    expect(personMatches(owner, "5owner")).toBe(true);
    expect(personMatches(bo, "")).toBe(true);
  });

  it("sorts people into the chips: the owner only in All, holders under Folder access and their role", () => {
    expect([owner, sara, bo].filter((p) => personInFilter(p, "all"))).toHaveLength(3);
    expect([owner, sara, bo].filter((p) => personInFilter(p, "editor"))).toEqual([sara]);
    expect([owner, sara, bo].filter((p) => personInFilter(p, "viewer"))).toEqual([bo]);
    expect([owner, sara, bo].filter((p) => personInFilter(p, "folder"))).toEqual([bo]);
  });

  it("finds an invitation by its address, and a link by maker or role", () => {
    expect(pendingMatches({ recipientEmail: "mia@example.com" }, "MIA")).toBe(true);
    expect(pendingMatches({}, "mia")).toBe(false);
    expect(linkMatches(link(), "sara")).toBe(true);
    expect(linkMatches(link(), "editor")).toBe(true);
    expect(linkMatches(link(), "viewer")).toBe(false);
    expect(linkMatches(link({ mintedByYou: true }), "you")).toBe(true);
  });

  it("words Show all and the empty search, with no em dash", () => {
    expect(showAllLabel("people", 82)).toBe("Show all 82 people");
    expect(showAllLabel("pending", 6)).toBe("Show all 6 pending invites");
    expect(showAllLabel("links", 45)).toBe("Show all 45 links");
    expect(noMatchLine(" zed ")).toBe("No one matches “zed”");
    for (const words of [showAllLabel("people", 2), noMatchLine("x"), ...Object.values(SEARCH_PLACEHOLDER)]) {
      expect(words).not.toContain("\u2014");
    }
  });
});
