import { describe, expect, it } from "vitest";

import {
  driveRowSharing,
  rolesByLocalLabel,
  writableMemberDriveLabels,
  manageableMemberDriveLabels,
} from "@/app/lib/shared-drives/driveRowSharing";

const OWNER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

describe("driveRowSharing", () => {
  // An own drive has both identity columns NULL by construction.
  it("says nothing about a private own drive", () => {
    expect(driveRowSharing({})).toEqual({
      isShared: false,
      direction: null,
      label: null,
      title: null,
    });
    expect(driveRowSharing({ ownerSs58: null }).isShared).toBe(false);
    expect(driveRowSharing({ ownerSs58: "" }).isShared).toBe(false);
  });

  it("marks a drive owned by another account, naming the owner in the tooltip", () => {
    const sharing = driveRowSharing({ ownerSs58: OWNER, role: "writer" });
    expect(sharing.isShared).toBe(true);
    expect(sharing.direction).toBe("with-me");
    expect(sharing.label).toBe("Shared · Editor");
    expect(sharing.title).toContain(OWNER);
  });

  // Rows and roles come from different sources, so a row can render before its
  // role has arrived. Guessing one is worse than showing none: "Viewer" on a
  // drive the user can write to actively misleads.
  it("shows the badge without a role when the role has not arrived", () => {
    const sharing = driveRowSharing({ ownerSs58: OWNER });
    expect(sharing.isShared).toBe(true);
    expect(sharing.label).toBe("Shared");
  });

  it("degrades an unknown role to the least privileged label", () => {
    expect(driveRowSharing({ ownerSs58: OWNER, role: "admin" }).label).toBe(
      "Shared · Viewer",
    );
  });

  it.each([
    ["reader", "Viewer"],
    ["writer", "Editor"],
    ["manager", "Manager"],
  ])("labels the wire role %s as %s", (wire, label) => {
    expect(driveRowSharing({ ownerSs58: OWNER, role: wire }).label).toBe(
      `Shared · ${label}`,
    );
  });
});

// The opposite direction, and the gap this closes: an owner had no way to tell
// a drive they had shared from a private one -- the badge only ever appeared
// on the receiving side.
describe("a drive this account has shared", () => {
  it("says how many people it reached", () => {
    const sharing = driveRowSharing({ memberCount: 3 });
    expect(sharing.isShared).toBe(true);
    expect(sharing.direction).toBe("by-me");
    expect(sharing.label).toBe("Shared with 3");
    expect(sharing.title).toContain("3 people");
  });

  it("reads naturally for a single person", () => {
    expect(driveRowSharing({ memberCount: 1 }).title).toContain("1 person");
  });

  it("stays unmarked when nobody has joined", () => {
    expect(driveRowSharing({ memberCount: 0 }).isShared).toBe(false);
  });

  // Not knowing must not read as "private": the count arrives after the row.
  it("shows nothing while the count is unknown", () => {
    expect(driveRowSharing({}).isShared).toBe(false);
    expect(driveRowSharing({ memberCount: undefined }).isShared).toBe(false);
  });

  // Whose drive it is wins: a member drive is someone else's however many
  // other people are in it.
  it("prefers the with-me reading on a drive owned by someone else", () => {
    const sharing = driveRowSharing({
      ownerSs58: OWNER,
      role: "writer",
      memberCount: 5,
    });
    expect(sharing.direction).toBe("with-me");
    expect(sharing.label).toBe("Shared · Editor");
  });
});

describe("rolesByLocalLabel", () => {
  it("indexes the drives that are actually synced here", () => {
    const map = rolesByLocalLabel([
      { localLabel: "team-docs", syncedLocally: true, role: "manager" },
      { localLabel: "design", syncedLocally: true, role: "reader" },
    ]);
    expect(map.get("team-docs")).toBe("manager");
    expect(map.get("design")).toBe("reader");
  });

  // A membership not yet added has no local label; it belongs to "Shared with
  // me", not to the drive list.
  it("skips memberships that are not synced locally", () => {
    const map = rolesByLocalLabel([
      { localLabel: null, syncedLocally: false, role: "writer" },
      { localLabel: "ghost", syncedLocally: false, role: "writer" },
      { syncedLocally: true, role: "writer" },
    ]);
    expect(map.size).toBe(0);
  });

  it("degrades an unknown role rather than storing it raw", () => {
    const map = rolesByLocalLabel([
      { localLabel: "odd", syncedLocally: true, role: "superuser" },
    ]);
    expect(map.get("odd")).toBe("reader");
  });

  it("returns an empty index for an empty listing", () => {
    expect(rolesByLocalLabel([]).size).toBe(0);
  });
});

// The state that was rendering as "never shared": the owner shared the drive,
// every link has since lapsed, and nobody joined.
describe("a drive whose invites have all lapsed", () => {
  it("is still marked, and says what happened", () => {
    const sharing = driveRowSharing({ totalInviteCount: 2 });
    expect(sharing.isShared).toBe(true);
    expect(sharing.direction).toBe("by-me");
    expect(sharing.label).toBe("Link expired");
  });

  it("prefers a live link over a lapsed one", () => {
    expect(
      driveRowSharing({ liveInviteCount: 1, totalInviteCount: 3 }).label,
    ).toBe("Invite sent");
  });

  it("prefers members over any link state", () => {
    expect(
      driveRowSharing({ memberCount: 2, liveInviteCount: 0, totalInviteCount: 5 })
        .label,
    ).toBe("Shared with 2");
  });

  it("leaves a drive with no invites and no members unmarked", () => {
    expect(driveRowSharing({ totalInviteCount: 0 }).isShared).toBe(false);
  });
});

describe("writableMemberDriveLabels", () => {
  const m = (role: string, over: Record<string, unknown> = {}) => ({
    ownerSs58: "5Owner",
    folderHash: `h-${role}`,
    role,
    localLabel: null as string | null,
    ...over,
  });

  it("holds Editors and Managers, under both spellings of the drive", () => {
    const set = writableMemberDriveLabels([
      m("writer", { localLabel: "team" }),
      m("manager"),
      m("reader", { localLabel: "readonly" }),
    ]);
    expect(set.has("team")).toBe(true);
    expect(set.has("shared:5Owner~h-writer")).toBe(true);
    expect(set.has("shared:5Owner~h-manager")).toBe(true);
    expect(set.has("readonly")).toBe(false);
    expect(set.has("shared:5Owner~h-reader")).toBe(false);
  });

  it("leaves a frozen drive out, whatever the role", () => {
    const set = writableMemberDriveLabels([m("manager", { frozen: true, localLabel: "cold" })]);
    expect(set.size).toBe(0);
  });

  it("degrades an unknown role to no write access", () => {
    expect(writableMemberDriveLabels([m("owner")]).size).toBe(0);
  });
});

describe("folder grants in the label sets", () => {
  const grant = (role: string, over: Record<string, unknown> = {}) => ({
    ownerSs58: "5Owner",
    folderHash: "h",
    pathPrefix: `Clients/${role}`,
    role,
    ...over,
  });

  it("adds a granted folder's grant: label where its role allows", () => {
    const writable = writableMemberDriveLabels([], [grant("writer"), grant("reader")]);
    expect([...writable]).toEqual(["grant:5Owner~h~436c69656e74732f777269746572"]);
  });

  it("never makes a granted folder manageable: Manager is not a folder role", () => {
    const manageable = manageableMemberDriveLabels([
      { ownerSs58: "5Owner", folderHash: "h", role: "manager", localLabel: null },
    ]);
    expect([...manageable]).toEqual(["shared:5Owner~h"]);
    expect([...manageable].some((l) => l.startsWith("grant:"))).toBe(false);
  });

  it("leaves a frozen grant out", () => {
    expect(writableMemberDriveLabels([], [grant("writer", { frozen: true })]).size).toBe(0);
  });
});
