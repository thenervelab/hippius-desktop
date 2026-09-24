import { describe, it, expect } from "vitest";
import {
  couldNotChangeAccess,
  describeLinkLifetime,
  describeLinkUses,
  expiresInLabel,
  generalAccessNote,
  noticeForError,
  peopleHaveAccess,
  pendingInviteMeta,
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
      "Anyone with the link can join for as long as it exists.",
    );
    expect(generalAccessNote({ folder: false, role: "reader", neverExpires: false })).toBe(
      "Anyone with the link can join until it expires.",
    );
  });
});

describe("pending invite rows", () => {
  const now = new Date("2026-09-24T12:00:00Z");

  it("counts days left, rounding up, and says today and tomorrow", () => {
    expect(expiresInLabel("2026-09-30T12:00:00Z", now)).toBe("expires in 6 days");
    expect(expiresInLabel("2026-09-30T13:00:00Z", now)).toBe("expires in 7 days");
    expect(expiresInLabel("2026-09-24T18:00:00Z", now)).toBe("expires today");
    expect(expiresInLabel("2026-09-25T11:00:00Z", now)).toBe("expires tomorrow");
    expect(expiresInLabel("2026-09-20T00:00:00Z", now)).toBe("expired");
    expect(expiresInLabel("not a date", now)).toBeNull();
  });

  it("names the stage, and approval when it is needed", () => {
    expect(pendingInviteMeta({ emailStatus: "sent", expiresAt: "2026-09-30T12:00:00Z" }, now)).toBe(
      "Invite sent · expires in 6 days",
    );
    expect(pendingInviteMeta({ emailStatus: "awaiting_seal", expiresAt: "x" }, now)).toBe("Needs your approval");
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
