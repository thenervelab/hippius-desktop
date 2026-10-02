import { describe, it, expect } from "vitest";
import {
  addPeopleGate,
  couldNotChangeAccess,
  driveFullCopy,
  describeLinkLifetime,
  describeLinkUses,
  emailInviteNote,
  expiresInLabel,
  generalAccessNote,
  linkHint,
  noticeForError,
  peopleCount,
  peopleHaveAccess,
  pendingInviteMeta,
  sharingGate,
} from "../shareDialogState";
import { COMING_SOON_COPY, NEVER_EXPIRES_SECS } from "../../shareDriveModalState";

const notReady = (subkind: string, message = "x") => ({ kind: "NotReady", subkind, message });

describe("describeLinkLifetime", () => {
  it("names the presets the way the picker does", () => {
    expect(describeLinkLifetime(24 * 3600)).toBe("Expires in 24 hours");
    expect(describeLinkLifetime(7 * 24 * 3600)).toBe("Expires in 7 days");
    expect(describeLinkLifetime(30 * 24 * 3600)).toBe("Expires in 30 days");
  });

  it("says never for the server's lifetime cap", () => {
    expect(describeLinkLifetime(NEVER_EXPIRES_SECS)).toBe("Never expires");
  });

  // A lifetime Rust capped to something off the preset list still reads.
  it("words an off-preset lifetime in hours or days", () => {
    expect(describeLinkLifetime(3600)).toBe("Expires in 1 hour");
    expect(describeLinkLifetime(5 * 3600)).toBe("Expires in 5 hours");
    expect(describeLinkLifetime(3 * 24 * 3600)).toBe("Expires in 3 days");
    expect(describeLinkLifetime(7 * 24 * 3600 - 5)).toBe("Expires in 7 days");
    expect(describeLinkLifetime(23 * 3600 + 1800)).toBe("Expires in 24 hours");
    expect(describeLinkLifetime(1800)).toBe("Expires in less than an hour");
    expect(describeLinkLifetime(0)).toBe("Expired");
  });
});

describe("describeLinkUses", () => {
  it("calls one use single use", () => {
    expect(describeLinkUses(1)).toBe("Single use");
    expect(describeLinkUses(50)).toBe("Up to 50 uses");
  });
});

// Routed on the structured subkind only; the message text never decides.
describe("noticeForError", () => {
  it.each([
    ["EMAIL_INVITES_UNAVAILABLE", { kind: "comingSoon", text: COMING_SOON_COPY.email }],
    ["FOLDER_EMAIL_INVITES_UNAVAILABLE", { kind: "comingSoon", text: COMING_SOON_COPY.folderEmail }],
    ["FOLDER_INVITES_UNAVAILABLE", { kind: "comingSoon", text: COMING_SOON_COPY.folder }],
    ["FOLDER_EDITOR_INVITES_UNAVAILABLE", { kind: "folderEditor" }],
    ["SHARED_DRIVES_NOT_ENTITLED", { kind: "notEntitled" }],
  ])("%s", (subkind, expected) => {
    expect(noticeForError(notReady(subkind))).toEqual(expected);
  });

  it("passes Rust's own words through for everything else", () => {
    expect(noticeForError(notReady("RATE_LIMITED", "Try again in 3 minutes."))).toEqual({
      kind: "error",
      message: "Try again in 3 minutes.",
    });
    expect(noticeForError({ kind: "Validation", message: "could not be sent" })).toEqual({
      kind: "error",
      message: "could not be sent",
    });
  });

  it("does not read a coming-soon out of an error's message", () => {
    expect(noticeForError({ kind: "Hcfs", message: "Sharing a single folder is coming soon." }).kind).toBe("error");
  });
});

describe("generalAccessNote", () => {
  it("says what the link can do before it is made", () => {
    expect(generalAccessNote({ folder: true, role: "writer", neverExpires: false })).toBe(
      "Works once, for the first person who opens it.",
    );
    expect(generalAccessNote({ folder: false, role: "manager", neverExpires: false })).toMatch(/^Works once and expires within 24 hours/);
    expect(generalAccessNote({ folder: false, role: "writer", neverExpires: true })).toBe(
      "Anyone with the link can join until you revoke it.",
    );
    expect(generalAccessNote({ folder: false, role: "reader", neverExpires: false })).toBe(
      "Anyone with the link can join until it expires.",
    );
  });
});

describe("emailInviteNote", () => {
  it("says a mailed Manager invite is single use and has to be taken up within 24 hours", () => {
    const note = emailInviteNote({ folder: false, role: "manager" });
    expect(note).toMatch(/^Works once and expires within 24 hours/);
    expect(note).toMatch(/join by then/);
  });

  it("says nothing for Viewer or Editor, or on a folder", () => {
    expect(emailInviteNote({ folder: false, role: "reader" })).toBeNull();
    expect(emailInviteNote({ folder: false, role: "writer" })).toBeNull();
    expect(emailInviteNote({ folder: true, role: "manager" })).toBeNull();
  });
});

describe("linkHint", () => {
  it("says who a link lets in and until when, with no word on the role", () => {
    expect(linkHint({ folder: true, neverExpires: true })).toBe("Works once, for the first person who opens it.");
    expect(linkHint({ folder: false, neverExpires: true })).toBe("Anyone with the link can join until you revoke it.");
    expect(linkHint({ folder: false, neverExpires: false })).toBe("Anyone with the link can join until it expires.");
  });
});

describe("pending invite rows", () => {
  const now = new Date("2026-09-24T12:00:00Z");

  it("counts time left rounding up, the same way Manage access does", () => {
    expect(expiresInLabel("2026-10-01T11:59:55Z", now)).toBe("expires in 7 days");
    expect(expiresInLabel("2026-09-30T13:00:00Z", now)).toBe("expires in 7 days");
    expect(expiresInLabel("2026-09-30T12:00:00Z", now)).toBe("expires in 6 days");
    expect(expiresInLabel("2026-09-25T12:00:00Z", now)).toBe("expires in 1 day");
    expect(expiresInLabel("2026-09-25T11:30:00Z", now)).toBe("expires in 24 hours");
    expect(expiresInLabel("2026-09-24T17:00:00Z", now)).toBe("expires in 5 hours");
    expect(expiresInLabel("2026-09-24T12:30:00Z", now)).toBe("expires in less than an hour");
    expect(expiresInLabel("2026-09-24T12:00:00Z", now)).toBe("expired");
    expect(expiresInLabel("2026-09-20T00:00:00Z", now)).toBe("expired");
    expect(expiresInLabel("2126-09-24T12:00:00Z", now)).toBe("never expires");
    expect(expiresInLabel("not a date", now)).toBeNull();
  });

  it("names the stage, and approval when it is needed", () => {
    expect(pendingInviteMeta({ emailStatus: "sent", expiresAt: "2026-10-01T11:59:55Z" }, now)).toBe(
      "Invite sent · expires in 7 days",
    );
    expect(pendingInviteMeta({ emailStatus: "awaiting_seal", expiresAt: "x" }, now)).toBe("Opened · they join while the app is open");
  });
});

describe("row copy", () => {
  it("says who could not be changed, and why", () => {
    expect(couldNotChangeAccess("Ann", "Try again later.")).toBe("Couldn't change access for Ann. Try again later.");
    expect(couldNotChangeAccess("Ann", " ")).toBe("Couldn't change access for Ann.");
  });

  it("counts people", () => {
    expect(peopleHaveAccess(1)).toBe("1 person has access");
    expect(peopleHaveAccess(4)).toBe("4 people have access");
  });
});

describe("sharingGate", () => {
  const gate = (planAllows: boolean | undefined, owner = true, refusedByServer = false) =>
    sharingGate({ planAllows, owner, refusedByServer });

  it("offers the controls when the plan allows sharing", () => {
    expect(gate(true)).toBe("allowed");
  });

  it("shows the upgrade card when it does not", () => {
    expect(gate(false)).toBe("upgrade");
  });

  // Neither the controls nor the card may flash before the plan is known.
  it("waits while the plan is loading", () => {
    expect(gate(undefined)).toBe("loading");
  });

  // The server is the authority, whatever the app believed.
  it("shows the upgrade card after a 403 not-entitled, even on an allowed plan", () => {
    expect(gate(true, true, true)).toBe("upgrade");
    expect(gate(undefined, true, true)).toBe("upgrade");
  });

  // The plan is this account's; somebody else's drive is decided by its owner.
  it("never gates a drive this account does not own on its own plan", () => {
    expect(gate(false, false)).toBe("allowed");
    expect(gate(undefined, false)).toBe("allowed");
  });
});

describe("addPeopleGate", () => {
  const gate = (over: Partial<Parameters<typeof addPeopleGate>[0]> = {}) =>
    addPeopleGate({ canManage: true, sharing: "allowed", access: "ready", full: false, ...over });

  it("offers the controls while there is room", () => {
    expect(gate()).toBe("allowed");
  });

  it("warns once Rust says the drive is full", () => {
    expect(gate({ full: true })).toBe("full");
  });

  // The plan card answers first: a plan without sharing is not a full drive.
  it("lets the plan gate speak before the room", () => {
    expect(gate({ sharing: "upgrade", full: true })).toBe("upgrade");
    expect(gate({ sharing: "loading", full: true })).toBe("loading");
  });

  it("offers nothing to someone who cannot add people", () => {
    expect(gate({ canManage: false, full: true })).toBe("none");
  });

  // Room is unknown until the list is in, and a failed list knows nothing:
  // the server still refuses a join past the limit.
  it("keeps the controls while room is unknown", () => {
    expect(gate({ access: "loading", full: true })).toBe("allowed");
    expect(gate({ access: "error" })).toBe("allowed");
    expect(gate({ access: "unavailable" })).toBe("allowed");
  });
});

describe("driveFullCopy", () => {
  it("tells the owner their plan's number and to upgrade", () => {
    expect(driveFullCopy({ ownerIsYou: true, memberLimit: 8 })).toEqual({
      title: "This drive is full.",
      body: "Your plan allows 8 people. Upgrade your plan to add more.",
      action: "Upgrade plan",
    });
  });

  it("tells a Manager to ask the owner, with no upgrade", () => {
    expect(driveFullCopy({ ownerIsYou: false, memberLimit: 20 })).toEqual({
      title: "This drive is full.",
      body: "The owner\u2019s plan allows 20 people. Remove someone, or ask the owner to upgrade their plan.",
      action: null,
    });
  });

  it("still reads without a number", () => {
    expect(driveFullCopy({ ownerIsYou: true, memberLimit: null }).body).toBe(
      "It has as many people as your plan allows. Upgrade your plan to add more.",
    );
  });

  it("never talks about seats", () => {
    for (const ownerIsYou of [true, false]) {
      for (const memberLimit of [1, 3, null]) {
        const copy = driveFullCopy({ ownerIsYou, memberLimit });
        expect(`${copy.title} ${copy.body} ${copy.action ?? ""}`).not.toMatch(/seat/i);
      }
    }
  });
});

describe("noticeForError on a full drive", () => {
  it("routes DRIVE_FULL by its subkind, never its words", () => {
    expect(noticeForError(notReady("DRIVE_FULL", "anything"))).toEqual({ kind: "driveFull" });
    expect(noticeForError({ kind: "Other", message: "This drive is full." })).toEqual({
      kind: "error",
      message: "This drive is full.",
    });
  });
});

describe("peopleCount", () => {
  it("counts one person and many people", () => {
    expect(peopleCount(1)).toBe("1 person");
    expect(peopleCount(3)).toBe("3 people");
  });
});
